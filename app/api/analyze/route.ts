import { NextResponse } from "next/server";

import { callOpenRouter, planCrawlFromInstruction, sentimentOf, topKeywords } from "@/lib/analysis";
import { crawlComments } from "@/lib/crawler";
import { embedTextsLocal, embedTextsWithOpenRouter, vectorLiteral } from "@/lib/embedding";
import {
  fetchDocumentsByExternalIds,
  fetchEmbeddingHashMap,
  fetchRecentDocuments,
  getCrawlState,
  searchSimilarDocuments,
  upsertCrawlState,
  upsertDocuments,
  upsertEmbeddings,
} from "@/lib/supabase";
import { isProbableSpam, maskPII } from "@/lib/text-ops";
import type { AnalyzeRequest, CrawlInstructionPlan, CrawledComment, RuntimeConfig } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function toInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toNum(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v.toLowerCase() === "true") return true;
    if (v.toLowerCase() === "false") return false;
  }
  return fallback;
}

function buildConfig(body: AnalyzeRequest): RuntimeConfig {
  const userTier: RuntimeConfig["userTier"] = body.userTier === "pro" ? "pro" : "general";
  const providerRaw = String(body.embeddingProvider || "").trim().toLowerCase();
  let embeddingProvider: RuntimeConfig["embeddingProvider"] = "local";
  if (providerRaw === "openrouter") embeddingProvider = "openrouter";
  else if (providerRaw === "local") embeddingProvider = "local";
  else if (toBool(body.usePaidEmbedding, false) && userTier === "pro") embeddingProvider = "openrouter";

  return {
    sourceUrl: (body.sourceUrl || "").trim(),
    userQuery: (body.userQuery || "Analyze latest comments and provide actions.").trim(),
    userTier,
    crawlTargetInstruction: (body.crawlTargetInstruction || "").trim(),
    modelName: (body.modelName || "openai/gpt-oss-120b:free").trim(),
    embeddingProvider,
    crawlMode: body.crawlMode || "static",
    crawlScope: (body.crawlScope || "default").trim(),
    sortMode: (body.sortMode || "latest").trim(),
    lookbackHours: toInt(body.lookbackHours, 24),
    maxPages: Math.max(1, Math.min(100, toInt(body.maxPages, 8))),

    commentSelector:
      (body.commentSelector || ".comment, .reply, [data-comment-id], li[class*='comment']").trim(),
    authorSelector: (body.authorSelector || ".author, .user, .nickname, [class*='writer']").trim(),
    datetimeSelector: (body.datetimeSelector || "time, .date, .time, [class*='date']").trim(),
    parentSelector: (body.parentSelector || "").trim(),
    nextPageSelector: (body.nextPageSelector || "a[rel='next'], .next a, a.next").trim(),
    commentIdAttr: (body.commentIdAttr || "data-comment-id").trim(),
    parentIdAttr: (body.parentIdAttr || "data-parent-id").trim(),
    deletedSelector: (body.deletedSelector || "").trim(),
    deletedMarkersCsv:
      (body.deletedMarkersCsv || "[deleted],삭제된 댓글,삭제됨,deleted by user,removed").trim(),
    minCommentLength: Math.max(0, Math.min(100, toInt(body.minCommentLength, 2))),
    pageParamName: (body.pageParamName || "").trim(),
    pageStart: Math.max(1, toInt(body.pageStart, 1)),

    apiEndpoint: (body.apiEndpoint || "").trim(),
    apiMethod: body.apiMethod || "GET",
    apiParamsJson: body.apiParamsJson || "{}",
    apiPayloadJson: body.apiPayloadJson || "{}",
    apiCommentsPath: (body.apiCommentsPath || "data.comments").trim(),
    apiHasMorePath: (body.apiHasMorePath || "data.has_more").trim(),
    apiNextCursorPath: (body.apiNextCursorPath || "data.next_cursor").trim(),
    apiPageParam: (body.apiPageParam || "page").trim(),
    apiCursorParam: (body.apiCursorParam || "cursor").trim(),
    apiIdField: (body.apiIdField || "id").trim(),
    apiContentField: (body.apiContentField || "content").trim(),
    apiAuthorField: (body.apiAuthorField || "author").trim(),
    apiDatetimeField: (body.apiDatetimeField || "created_at").trim(),
    apiParentIdField: (body.apiParentIdField || "parent_id").trim(),
    apiDeletedField: (body.apiDeletedField || "is_deleted").trim(),

    extraHeadersJson: body.extraHeadersJson || "{}",
    cookieString: body.cookieString || "",
    authBearerToken: body.authBearerToken || "",
    requestDelaySec: Math.max(0, Math.min(3, toNum(body.requestDelaySec, 0.2))),
    maxRetries: Math.max(0, Math.min(8, toInt(body.maxRetries, 2))),
    retryBackoffSec: Math.max(0.1, Math.min(5, toNum(body.retryBackoffSec, 1))),
    defaultTimezoneOffsetHours: Math.max(-12, Math.min(14, toInt(body.defaultTimezoneOffsetHours, 0))),

    excludeDeletedFromModel: toBool(body.excludeDeletedFromModel, true),
    excludeSpamFromModel: toBool(body.excludeSpamFromModel, true),
    piiMaskBeforeModel: toBool(body.piiMaskBeforeModel, true),
    spamKeywordsCsv:
      (body.spamKeywordsCsv || "무료,수익,클릭,dm,텔레그램,바카라,bit.ly,investment,casino").trim(),
  };
}

function maxPublishedIso(rows: Array<{ published_at?: string | null }>): string {
  let max = 0;
  for (const row of rows) {
    const v = row.published_at ? Date.parse(row.published_at) : NaN;
    if (!Number.isNaN(v) && v > max) max = v;
  }
  return max > 0 ? new Date(max).toISOString() : new Date().toISOString();
}

function applyCrawlPlanToComments(
  comments: CrawledComment[],
  plan: CrawlInstructionPlan | null,
) {
  if (!plan) return comments;

  const hasRule =
    Boolean(plan.applyFilter) ||
    Boolean(plan.startDate) ||
    Boolean(plan.endDate) ||
    Boolean(plan.targetCommentCount);
  if (!hasRule) return comments;

  let rows = [...comments];

  const startTs = plan.startDate ? Date.parse(`${plan.startDate}T00:00:00Z`) : NaN;
  const endTs = plan.endDate ? Date.parse(`${plan.endDate}T23:59:59Z`) : NaN;
  if (!Number.isNaN(startTs) || !Number.isNaN(endTs)) {
    rows = rows.filter((row) => {
      if (!row.published_at) return true;
      const t = Date.parse(String(row.published_at));
      if (Number.isNaN(t)) return true;
      if (!Number.isNaN(startTs) && t < startTs) return false;
      if (!Number.isNaN(endTs) && t > endTs) return false;
      return true;
    });
  }

  if (plan.targetCommentCount && plan.targetCommentCount > 0) {
    rows.sort((a, b) => {
      const ta = a.published_at ? Date.parse(String(a.published_at)) : 0;
      const tb = b.published_at ? Date.parse(String(b.published_at)) : 0;
      return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
    });
    rows = rows.slice(0, plan.targetCommentCount);
  }
  return rows;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AnalyzeRequest;
    const cfg = buildConfig(body);
    if (!cfg.sourceUrl) {
      return NextResponse.json({ error: "sourceUrl is required." }, { status: 400 });
    }
    if (cfg.userTier !== "pro" && cfg.embeddingProvider === "openrouter") {
      cfg.embeddingProvider = "local";
    }

    const openrouterKey = requiredEnv("OPENROUTER_HACKERTHON_API_KEY");
    const embeddingModelName = (process.env.COMMENT_EMBEDDING_MODEL || "openai/text-embedding-3-small").trim();
    const embeddingDim = Math.max(1, Math.min(8192, toInt(process.env.COMMENT_EMBEDDING_DIM, 1536)));
    const embeddingModelLabel =
      cfg.embeddingProvider === "openrouter" ? embeddingModelName : `local-hash-${embeddingDim}`;
    const topK = toInt(process.env.COMMENT_TOP_K, 24);
    const maxContextChars = toInt(process.env.COMMENT_MAX_CONTEXT_CHARS, 14000);
    const timeoutSec = toInt(process.env.COMMENT_REQUEST_TIMEOUT_SEC, 45);

    const crawlPlan = await planCrawlFromInstruction({
      apiKey: openrouterKey,
      modelName: cfg.modelName,
      sourceUrl: cfg.sourceUrl,
      instruction: cfg.crawlTargetInstruction,
      timeoutMs: timeoutSec * 1000,
    });
    if (crawlPlan?.recommendedMaxPages && crawlPlan.recommendedMaxPages > 0) {
      cfg.maxPages = Math.max(1, Math.min(100, crawlPlan.recommendedMaxPages));
    }
    if (crawlPlan?.recommendedLookbackHours !== null && crawlPlan?.recommendedLookbackHours !== undefined) {
      cfg.lookbackHours = Math.max(0, Math.min(24 * 365, crawlPlan.recommendedLookbackHours));
    }

    const state = await getCrawlState({
      sourceUrl: cfg.sourceUrl,
      crawlScope: cfg.crawlScope,
      sortMode: cfg.sortMode,
    });
    const rawSince = state?.last_crawled_at ? new Date(String(state.last_crawled_at)) : null;
    const adjustedSince =
      rawSince && cfg.lookbackHours > 0
        ? new Date(rawSince.getTime() - cfg.lookbackHours * 60 * 60 * 1000)
        : rawSince;

    const crawl = await crawlComments(cfg, adjustedSince);

    const effectiveComments = applyCrawlPlanToComments(crawl.comments, crawlPlan);
    const nowIso = new Date().toISOString();
    const documentRows = effectiveComments.map((c) => {
      const masked = maskPII(c.content);
      const spam = isProbableSpam(c.content, c.author, cfg.spamKeywordsCsv);
      return {
        source_url: c.source_url,
        crawl_scope: cfg.crawlScope,
        sort_mode: cfg.sortMode,
        external_id: c.external_id,
        parent_external_id: c.parent_external_id,
        content: c.content,
        pii_masked_content: masked,
        author: c.author,
        comment_url: c.comment_url,
        published_at: c.published_at,
        status: c.status,
        is_spam: spam,
        source_type: c.source_type,
        metadata: c.metadata,
        content_hash: c.content_hash,
        last_seen_at: nowIso,
        updated_at: nowIso,
      };
    });

    if (documentRows.length) {
      await upsertDocuments(documentRows);
    }

    const externalIds = documentRows.map((r) => String(r.external_id));
    const storedDocs = externalIds.length ? await fetchDocumentsByExternalIds(cfg.sourceUrl, externalIds) : [];

    const embedCandidates = storedDocs.filter((d) => {
      if (cfg.excludeDeletedFromModel && d.status === "deleted") return false;
      if (cfg.excludeSpamFromModel && Boolean(d.is_spam)) return false;
      return true;
    });

    const hashMap = await fetchEmbeddingHashMap(embedCandidates.map((d) => String(d.id)));
    const toEmbed = embedCandidates.filter((d) => hashMap.get(String(d.id)) !== String(d.content_hash || ""));
    let embeddingError: string | null = null;
    let embeddedDocs = 0;

    if (toEmbed.length) {
      try {
        const texts = toEmbed.map((d) =>
          cfg.piiMaskBeforeModel ? String(d.pii_masked_content || d.content || "") : String(d.content || ""),
        );
        const vectors =
          cfg.embeddingProvider === "openrouter"
            ? await embedTextsWithOpenRouter({
                apiKey: openrouterKey,
                texts,
                modelName: embeddingModelName,
                timeoutMs: timeoutSec * 1000,
                expectedDim: embeddingDim,
              })
            : embedTextsLocal({
                texts,
                dim: embeddingDim,
              });
        const nowIso = new Date().toISOString();
        const rows = toEmbed.map((d, idx) => ({
          document_id: d.id,
          embedding: vectorLiteral(vectors[idx] || []),
          content_hash: d.content_hash,
          updated_at: nowIso,
        }));
        await upsertEmbeddings(rows);
        embeddedDocs = rows.length;
      } catch (err) {
        embeddingError = err instanceof Error ? err.message : "Embedding upsert failed.";
      }
    }

    await upsertCrawlState({
      sourceUrl: cfg.sourceUrl,
      crawlScope: cfg.crawlScope,
      sortMode: cfg.sortMode,
      lastCrawledAt: maxPublishedIso(documentRows),
      lastCursor: crawl.report.lastCursor || null,
      lastRunStatus: "ok",
    });

    let queryEmbeddingLiteral = "";
    try {
      const queryText = cfg.piiMaskBeforeModel ? maskPII(cfg.userQuery) : cfg.userQuery;
      const queryVectors =
        cfg.embeddingProvider === "openrouter"
          ? await embedTextsWithOpenRouter({
              apiKey: openrouterKey,
              texts: [queryText],
              modelName: embeddingModelName,
              timeoutMs: timeoutSec * 1000,
              batchSize: 1,
              expectedDim: embeddingDim,
            })
          : embedTextsLocal({
              texts: [queryText],
              dim: embeddingDim,
            });
      const vec = queryVectors[0];
      if (!vec?.length) throw new Error("Embedding provider returned empty query vector.");
      queryEmbeddingLiteral = vectorLiteral(vec);
    } catch (err) {
      if (!embeddingError) embeddingError = err instanceof Error ? err.message : "Query embedding failed.";
    }

    let ragDocs: Record<string, unknown>[] = [];
    if (queryEmbeddingLiteral) {
      try {
        ragDocs = (await searchSimilarDocuments({
          sourceUrl: cfg.sourceUrl,
          crawlScope: cfg.crawlScope,
          sortMode: cfg.sortMode,
          queryEmbeddingLiteral,
          topK,
          excludeDeleted: cfg.excludeDeletedFromModel,
          excludeSpam: cfg.excludeSpamFromModel,
        })) as Record<string, unknown>[];
      } catch {
        ragDocs = [];
      }
    }
    if (!ragDocs.length) {
      ragDocs = (await fetchRecentDocuments({
        sourceUrl: cfg.sourceUrl,
        crawlScope: cfg.crawlScope,
        sortMode: cfg.sortMode,
        topK,
        excludeDeleted: cfg.excludeDeletedFromModel,
        excludeSpam: cfg.excludeSpamFromModel,
      })) as Record<string, unknown>[];
    }

    const analysisMarkdown = await callOpenRouter({
      apiKey: openrouterKey,
      modelName: cfg.modelName,
      sourceUrl: cfg.sourceUrl,
      userQuery: cfg.userQuery,
      docs: ragDocs,
      maxContextChars,
      timeoutMs: timeoutSec * 1000,
      useMasked: cfg.piiMaskBeforeModel,
    });

    const textKey = cfg.piiMaskBeforeModel ? "pii_masked_content" : "content";
    const sentiments = { positive: 0, neutral: 0, negative: 0 };
    for (const d of ragDocs) {
      const text = String(d[textKey] || d.content || "");
      const s = sentimentOf(text);
      sentiments[s] += 1;
    }
    const keywords = topKeywords(
      ragDocs.map((d) => String(d[textKey] || d.content || "")),
      12,
    );

    return NextResponse.json({
      ingestion: {
        sinceDt: rawSince ? rawSince.toISOString() : null,
        adjustedSinceDt: adjustedSince ? adjustedSince.toISOString() : null,
        pagesScanned: crawl.report.pagesScanned,
        commentsFound: crawl.report.commentsFound,
        commentsKept: documentRows.length,
        storedDocs: storedDocs.length,
        embeddedDocs,
        embeddingSkippedUnchanged: embedCandidates.length - toEmbed.length,
        embeddingProvider: cfg.embeddingProvider,
        embeddingModel: embeddingModelLabel,
        embeddingError,
        deletedDetected: documentRows.filter((r) => r.status === "deleted").length,
        spamDetected: documentRows.filter((r) => r.is_spam).length,
        crawlMode: crawl.report.modeUsed,
        crawlNotes: crawl.report.notes,
        crawlInstructionApplied: Boolean(crawlPlan),
      },
      sentimentCounts: sentiments,
      keywords,
      analysisMarkdown,
      crawlPlan,
      documents: ragDocs.slice(0, 40),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
