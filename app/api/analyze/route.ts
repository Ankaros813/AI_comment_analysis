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

const DEFAULT_RAG_PROMPT =
  "최신 댓글 흐름을 요약하고 핵심 이슈, 감성 분포, 리스크, 즉시 실행 가능한 액션 아이템을 제안해줘.";

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

function trimOrDefault(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const s = v.trim();
  return s || fallback;
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

function buildConfig(body: AnalyzeRequest): RuntimeConfig {
  const userTier: RuntimeConfig["userTier"] = body.userTier === "pro" ? "pro" : "general";
  const providerRaw = String(body.embeddingProvider || "").trim().toLowerCase();
  let embeddingProvider: RuntimeConfig["embeddingProvider"] = "local";
  if (providerRaw === "openrouter") embeddingProvider = "openrouter";
  else if (providerRaw === "local") embeddingProvider = "local";
  else if (toBool(body.usePaidEmbedding, false) && userTier === "pro") embeddingProvider = "openrouter";

  return {
    sourceUrl: trimOrDefault(body.sourceUrl, ""),
    userQuery: trimOrDefault(body.userQuery, DEFAULT_RAG_PROMPT),
    userTier,
    crawlTargetInstruction: trimOrDefault(body.crawlTargetInstruction, ""),
    modelName: trimOrDefault(body.modelName, "openai/gpt-4o-mini-2024-07-18"),
    embeddingProvider,
    crawlMode: "auto",
    collectionMode: body.collectionMode === "list_to_posts" ? "list_to_posts" : "single_page",
    crawlScope: (body.crawlScope || "default").trim(),
    sortMode: (body.sortMode || "latest").trim(),
    lookbackHours: toInt(body.lookbackHours, 24),
    maxPages: Math.max(1, Math.min(100, toInt(body.maxPages, 8))),
    maxPosts: Math.max(1, Math.min(500, toInt(body.maxPosts, 40))),
    maxCommentPagesPerPost: Math.max(1, Math.min(30, toInt(body.maxCommentPagesPerPost, 3))),

    commentSelector:
      (body.commentSelector || ".comment, .reply, [data-comment-id], li[class*='comment']").trim(),
    authorSelector: (body.authorSelector || ".author, .user, .nickname, [class*='writer']").trim(),
    datetimeSelector: (body.datetimeSelector || "time, .date, .time, [class*='date']").trim(),
    parentSelector: (body.parentSelector || "").trim(),
    nextPageSelector: (body.nextPageSelector || "a[rel='next'], .next a, a.next").trim(),
    listNextPageSelector:
      (body.listNextPageSelector || body.nextPageSelector || "a[rel='next'], .next a, a.next, .btn_next").trim(),
    commentNextPageSelector:
      (body.commentNextPageSelector || body.nextPageSelector || "a[rel='next'], .next a, a.next").trim(),
    commentIdAttr: (body.commentIdAttr || "data-comment-id").trim(),
    parentIdAttr: (body.parentIdAttr || "data-parent-id").trim(),
    deletedSelector: (body.deletedSelector || "").trim(),
    deletedMarkersCsv:
      (body.deletedMarkersCsv || "[deleted],삭제된 댓글,삭제됨,deleted by user,removed").trim(),
    minCommentLength: Math.max(0, Math.min(100, toInt(body.minCommentLength, 2))),
    pageParamName: (body.pageParamName || "").trim(),
    pageStart: Math.max(1, toInt(body.pageStart, 1)),
    postLinkSelector:
      (body.postLinkSelector ||
        "a[href*='/board/view'], a[href*='/article/'], a[href*='/post/'], a[href*='view?']").trim(),
    postUrlIncludes: (body.postUrlIncludes || "").trim(),
    postUrlRegex: (body.postUrlRegex || "").trim(),

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

function buildNoDataMessage(cfg: RuntimeConfig, crawlNotes: string): string {
  let host = "";
  try {
    host = new URL(cfg.sourceUrl).host.toLowerCase();
  } catch {}
  const isNaverNews = host.includes("naver.com") && cfg.sourceUrl.includes("/article/");

  const lines = [
    "## 수집 결과 안내",
    "- 이번 실행에서 새 댓글이 수집되지 않았습니다.",
    "- 그래서 문서/임베딩 테이블에도 새로 저장된 항목이 없습니다.",
    "",
    "## 가능한 원인",
    "- 현재 페이지의 댓글이 정적 HTML에 없고, 브라우저에서 JS로 동적 로딩되는 구조",
    "- `HTML Selectors`가 실제 댓글 DOM 구조와 불일치",
    "- 로그인/쿠키/헤더가 필요한 댓글 API 구조",
  ];

  if (cfg.collectionMode === "list_to_posts") {
    lines.push("- 목록 모드에서 게시글 링크 selector/post URL 필터가 실제 구조와 맞지 않을 수 있음");
  }

  if (crawlNotes) {
    lines.push("", "## 크롤링 노트", `- ${crawlNotes}`);
  }

  lines.push(
    "",
    "## 바로 시도할 해결 방법",
    "- `Auto Crawl`은 내부적으로 API 경로를 우선 시도하고, 실패 시 정적 수집으로 폴백합니다.",
    "- 또는 `HTML Selectors`에서 댓글/작성자/시간 selector를 해당 사이트 구조에 맞게 수정",
    "- 테스트 시 `Max Pages`를 1~2로 낮춰 빠르게 검증",
  );

  if (isNaverNews) {
    lines.push(
      "",
      "## 네이버 뉴스 URL 안내",
      "- 네이버 뉴스 댓글은 동적 렌더링 비중이 높아 `static` 모드에서 0건이 나올 수 있습니다.",
      "- 이 경우 사이트 맞춤 API 설정 또는 외부 동적 크롤러 연동이 필요합니다.",
    );
  }

  return lines.join("\n");
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

  let startTs = plan.startDate ? Date.parse(`${plan.startDate}T00:00:00Z`) : NaN;
  let endTs = plan.endDate ? Date.parse(`${plan.endDate}T23:59:59Z`) : NaN;
  const nowTs = Date.now();

  // Guard against planner-produced future dates that would filter out all current comments.
  if (!Number.isNaN(startTs) && startTs > nowTs) startTs = NaN;
  if (!Number.isNaN(endTs) && endTs > nowTs) endTs = nowTs;
  if (!Number.isNaN(startTs) && !Number.isNaN(endTs) && startTs > endTs) {
    const tmp = startTs;
    startTs = endTs;
    endTs = tmp;
  }

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
    const rawDocumentRows = effectiveComments.map((c) => {
      const masked = maskPII(c.content);
      const spam = isProbableSpam(c.content, c.author, cfg.spamKeywordsCsv);
      const commentMetadata = asRecord(c.metadata);
      return {
        // Keep retrieval isolation strict: all rows from this run are keyed by the input URL.
        source_url: cfg.sourceUrl,
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
        metadata: {
          ...commentMetadata,
          input_source_url: cfg.sourceUrl,
          crawl_scope: cfg.crawlScope,
          sort_mode: cfg.sortMode,
        },
        content_hash: c.content_hash,
        last_seen_at: nowIso,
        updated_at: nowIso,
      };
    });
    const dedupedByExternalId = new Map<string, (typeof rawDocumentRows)[number]>();
    for (const row of rawDocumentRows) {
      const ext = String(row.external_id || "").trim();
      if (!ext) continue;
      if (!dedupedByExternalId.has(ext)) {
        dedupedByExternalId.set(ext, row);
      }
    }
    const documentRows = [...dedupedByExternalId.values()];
    const uniqueExternalIds = dedupedByExternalId.size;
    const dedupDropped = Math.max(0, rawDocumentRows.length - uniqueExternalIds);

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

    if (documentRows.length || state?.last_crawled_at) {
      await upsertCrawlState({
        sourceUrl: cfg.sourceUrl,
        crawlScope: cfg.crawlScope,
        sortMode: cfg.sortMode,
        lastCrawledAt: documentRows.length
          ? maxPublishedIso(documentRows)
          : new Date(String(state?.last_crawled_at)).toISOString(),
        lastCursor: crawl.report.lastCursor || null,
        lastRunStatus: "ok",
      });
    }

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

    const analysisMarkdown =
      ragDocs.length || documentRows.length
        ? await callOpenRouter({
            apiKey: openrouterKey,
            modelName: cfg.modelName,
            sourceUrl: cfg.sourceUrl,
            userQuery: cfg.userQuery,
            docs: ragDocs,
            maxContextChars,
            timeoutMs: timeoutSec * 1000,
            useMasked: cfg.piiMaskBeforeModel,
          })
        : buildNoDataMessage(cfg, crawl.report.notes);

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
        commentsFoundRaw: crawl.report.commentsFoundRaw ?? crawl.report.commentsFound,
        commentsKept: documentRows.length,
        uniqueExternalIds,
        externalIdDedupDropped: dedupDropped,
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
