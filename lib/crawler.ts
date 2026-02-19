import * as cheerio from "cheerio";

import type { CrawledComment, CrawlReport, RuntimeConfig } from "./types";
import { detectDeleted, normalizeWhitespace, parseDateToIso, stableSha1 } from "./text-ops";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson(raw: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const obj = JSON.parse(raw || "{}");
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
  } catch {}
  return fallback;
}

function cookieHeader(cookieString: string): string {
  return cookieString.trim();
}

function headersFromConfig(cfg: RuntimeConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };
  const extra = safeJson(cfg.extraHeadersJson, {});
  for (const [key, value] of Object.entries(extra)) {
    if (value == null) continue;
    headers[key] = String(value);
  }
  if (cfg.cookieString.trim()) {
    headers.cookie = cookieHeader(cfg.cookieString);
  }
  if (cfg.authBearerToken.trim()) {
    headers.authorization = `Bearer ${cfg.authBearerToken.trim()}`;
  }
  return headers;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries: number,
  retryBackoffSec: number,
): Promise<Response | null> {
  const attempts = Math.max(0, maxRetries) + 1;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500) throw new Error(`Server error ${res.status}`);
      return res;
    } catch {
      if (i + 1 >= attempts) return null;
      await sleep(Math.max(100, retryBackoffSec * 1000 * 2 ** i));
    }
  }
  return null;
}

function setPageParam(urlStr: string, param: string, value: number): string {
  const u = new URL(urlStr);
  u.searchParams.set(param, String(value));
  return u.toString();
}

function isSameDomain(base: string, target: string): boolean {
  try {
    return new URL(base).host === new URL(target).host;
  } catch {
    return false;
  }
}

function getByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const tokens = path.split(".").map((v) => v.trim()).filter(Boolean);
  let cur: unknown = obj;
  for (const token of tokens) {
    if (Array.isArray(cur)) {
      const idx = Number(token);
      if (Number.isNaN(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
      continue;
    }
    if (!cur || typeof cur !== "object") return undefined;
    const rec = cur as Record<string, unknown>;
    if (!(token in rec)) return undefined;
    cur = rec[token];
  }
  return cur;
}

function extractFromHtml(
  html: string,
  pageUrl: string,
  cfg: RuntimeConfig,
  sinceDate: Date | null,
  seenExternalIds: Set<string>,
): { comments: CrawledComment[]; found: number; nextLinks: string[] } {
  const $ = cheerio.load(html);
  const nodes = $(cfg.commentSelector);
  const found = nodes.length;
  const comments: CrawledComment[] = [];

  nodes.each((idx, el) => {
    const node = $(el);
    const content = normalizeWhitespace(node.text());

    const deletedBySelector = cfg.deletedSelector ? node.find(cfg.deletedSelector).length > 0 : false;
    const deletedByText = detectDeleted(content, cfg.deletedMarkersCsv);
    const isDeleted = deletedBySelector || deletedByText;
    if (!isDeleted && content.length < cfg.minCommentLength) return;

    const author = cfg.authorSelector ? normalizeWhitespace(node.find(cfg.authorSelector).first().text()) : "";

    const dtNode = cfg.datetimeSelector ? node.find(cfg.datetimeSelector).first() : undefined;
    const dtRaw = dtNode && dtNode.length ? dtNode.attr("datetime") || dtNode.text() : "";
    const publishedIso = parseDateToIso(dtRaw || "", cfg.defaultTimezoneOffsetHours);
    if (sinceDate && publishedIso) {
      const d = new Date(publishedIso);
      if (!Number.isNaN(d.getTime()) && d <= sinceDate) return;
    }

    let externalId = cfg.commentIdAttr ? node.attr(cfg.commentIdAttr) || "" : "";
    if (!externalId) {
      externalId = stableSha1(`${pageUrl}|${idx}|${author}|${publishedIso || ""}|${content}`);
    }
    if (seenExternalIds.has(externalId)) return;
    seenExternalIds.add(externalId);

    let parentExternalId = cfg.parentIdAttr ? node.attr(cfg.parentIdAttr) || "" : "";
    if (!parentExternalId && cfg.parentSelector && cfg.commentIdAttr) {
      const parentNode = node.find(cfg.parentSelector).first();
      parentExternalId = parentNode.attr(cfg.commentIdAttr) || "";
    }

    const contentHash = stableSha1(`${cfg.sourceUrl}|${externalId}|${author}|${publishedIso || ""}|${content}`);
    comments.push({
      source_url: cfg.sourceUrl,
      external_id: externalId,
      parent_external_id: parentExternalId || null,
      content,
      pii_masked_content: "",
      author: author || null,
      comment_url: pageUrl,
      published_at: publishedIso,
      status: isDeleted ? "deleted" : "active",
      is_spam: false,
      source_type: "static_html",
      metadata: {
        collected_at: new Date().toISOString(),
        sort_mode: cfg.sortMode,
      },
      content_hash: contentHash,
    });
  });

  const nextLinks: string[] = [];
  if (cfg.nextPageSelector) {
    $(cfg.nextPageSelector).each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      try {
        const nextUrl = new URL(href, pageUrl).toString();
        if (isSameDomain(cfg.sourceUrl, nextUrl)) nextLinks.push(nextUrl);
      } catch {}
    });
  }
  return { comments, found, nextLinks };
}

async function crawlStatic(
  cfg: RuntimeConfig,
  sinceDate: Date | null,
): Promise<{ comments: CrawledComment[]; report: CrawlReport }> {
  const headers = headersFromConfig(cfg);
  const seenExternalIds = new Set<string>();
  const visited = new Set<string>();
  const comments: CrawledComment[] = [];
  let commentsFound = 0;

  const queue: string[] = cfg.pageParamName
    ? Array.from({ length: cfg.maxPages }, (_, i) => setPageParam(cfg.sourceUrl, cfg.pageParamName, cfg.pageStart + i))
    : [cfg.sourceUrl];

  while (queue.length && visited.size < cfg.maxPages) {
    const pageUrl = queue.shift() as string;
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);

    const res = await fetchWithRetry(
      pageUrl,
      { method: "GET", headers },
      cfg.maxRetries,
      cfg.retryBackoffSec,
    );
    if (!res || res.status >= 400) continue;
    const html = await res.text();
    const { comments: extracted, found, nextLinks } = extractFromHtml(
      html,
      pageUrl,
      cfg,
      sinceDate,
      seenExternalIds,
    );
    commentsFound += found;
    comments.push(...extracted);

    if (!cfg.pageParamName) {
      for (const nextUrl of nextLinks) {
        if (!visited.has(nextUrl)) queue.push(nextUrl);
      }
    }
    if (cfg.requestDelaySec > 0) {
      await sleep(Math.floor(cfg.requestDelaySec * 1000));
    }
  }

  return {
    comments,
    report: {
      pagesScanned: visited.size,
      commentsFound,
      commentsKept: comments.length,
      modeUsed: "static",
      notes:
        commentsFound > 0
          ? ""
          : `댓글 노드를 찾지 못했습니다. commentSelector="${cfg.commentSelector}"`,
      lastCursor: null,
    },
  };
}

async function crawlApiJson(
  cfg: RuntimeConfig,
  sinceDate: Date | null,
): Promise<{ comments: CrawledComment[]; report: CrawlReport }> {
  const endpoint = cfg.apiEndpoint || cfg.sourceUrl;
  const headers = {
    "content-type": "application/json",
    ...headersFromConfig(cfg),
  };
  const baseParams = safeJson(cfg.apiParamsJson, {});
  const basePayload = safeJson(cfg.apiPayloadJson, {});
  const seenExternalIds = new Set<string>();
  const comments: CrawledComment[] = [];
  let commentsFound = 0;
  let cursor: string | null = null;
  let hasMore = true;
  let pagesScanned = 0;

  while (hasMore && pagesScanned < cfg.maxPages) {
    const pageNum = cfg.pageStart + pagesScanned;
    pagesScanned += 1;

    const params = { ...baseParams };
    const payload = { ...basePayload };
    if (cfg.apiPageParam) {
      if (cfg.apiMethod === "GET") params[cfg.apiPageParam] = pageNum;
      else payload[cfg.apiPageParam] = pageNum;
    }
    if (cfg.apiCursorParam && cursor) {
      if (cfg.apiMethod === "GET") params[cfg.apiCursorParam] = cursor;
      else payload[cfg.apiCursorParam] = cursor;
    }

    const urlObj = new URL(endpoint);
    if (cfg.apiMethod === "GET") {
      for (const [k, v] of Object.entries(params)) {
        urlObj.searchParams.set(k, String(v));
      }
    }

    const res = await fetchWithRetry(
      urlObj.toString(),
      {
        method: cfg.apiMethod,
        headers,
        body: cfg.apiMethod === "GET" ? undefined : JSON.stringify(payload),
      },
      cfg.maxRetries,
      cfg.retryBackoffSec,
    );
    if (!res || res.status >= 400) break;

    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      break;
    }
    const rows = getByPath(json, cfg.apiCommentsPath);
    const rowList = Array.isArray(rows) ? rows : [];
    commentsFound += rowList.length;

    for (let i = 0; i < rowList.length; i += 1) {
      const row = rowList[i];
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const content = normalizeWhitespace(String(getByPath(rec, cfg.apiContentField) || ""));
      const author = normalizeWhitespace(String(getByPath(rec, cfg.apiAuthorField) || ""));
      const dtRaw = String(getByPath(rec, cfg.apiDatetimeField) || "");
      const publishedIso = parseDateToIso(dtRaw, cfg.defaultTimezoneOffsetHours);
      if (sinceDate && publishedIso) {
        const d = new Date(publishedIso);
        if (!Number.isNaN(d.getTime()) && d <= sinceDate) continue;
      }

      const deletedRaw = getByPath(rec, cfg.apiDeletedField);
      const deletedByFlag = Boolean(deletedRaw);
      const deletedByText = detectDeleted(content, cfg.deletedMarkersCsv);
      const isDeleted = deletedByFlag || deletedByText;
      if (!isDeleted && content.length < cfg.minCommentLength) continue;

      let externalId = String(getByPath(rec, cfg.apiIdField) || "");
      if (!externalId) {
        externalId = stableSha1(`${endpoint}|${i}|${author}|${publishedIso || ""}|${content}`);
      }
      if (seenExternalIds.has(externalId)) continue;
      seenExternalIds.add(externalId);

      const parentId = String(getByPath(rec, cfg.apiParentIdField) || "");
      const contentHash = stableSha1(`${cfg.sourceUrl}|${externalId}|${author}|${publishedIso || ""}|${content}`);

      comments.push({
        source_url: cfg.sourceUrl,
        external_id: externalId,
        parent_external_id: parentId || null,
        content,
        pii_masked_content: "",
        author: author || null,
        comment_url: endpoint,
        published_at: publishedIso,
        status: isDeleted ? "deleted" : "active",
        is_spam: false,
        source_type: "api_json",
        metadata: {
          collected_at: new Date().toISOString(),
          sort_mode: cfg.sortMode,
          page_num: pageNum,
          cursor,
        },
        content_hash: contentHash,
      });
    }

    const hasMoreRaw = getByPath(json, cfg.apiHasMorePath);
    const nextCursor = getByPath(json, cfg.apiNextCursorPath);
    cursor = nextCursor == null ? null : String(nextCursor);
    hasMore = typeof hasMoreRaw === "boolean" ? hasMoreRaw : Boolean(cursor) || rowList.length > 0;

    if (cfg.requestDelaySec > 0) {
      await sleep(Math.floor(cfg.requestDelaySec * 1000));
    }
  }

  return {
    comments,
    report: {
      pagesScanned,
      commentsFound,
      commentsKept: comments.length,
      modeUsed: "api_json",
      notes:
        commentsFound > 0
          ? ""
          : `API 응답에서 댓글 배열을 찾지 못했습니다. apiCommentsPath="${cfg.apiCommentsPath}"`,
      lastCursor: cursor,
    },
  };
}

export async function crawlComments(
  cfg: RuntimeConfig,
  sinceDate: Date | null,
): Promise<{ comments: CrawledComment[]; report: CrawlReport }> {
  if (cfg.crawlMode === "api_json") {
    return crawlApiJson(cfg, sinceDate);
  }
  if (cfg.crawlMode === "dynamic") {
    const fallback = await crawlStatic(cfg, sinceDate);
    fallback.report.modeUsed = "static";
    fallback.report.notes = "dynamic mode is not supported on Vercel serverless. Fell back to static mode.";
    return fallback;
  }
  return crawlStatic(cfg, sinceDate);
}
