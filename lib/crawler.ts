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

function parseJsonOrJsonp(raw: string): unknown | null {
  const text = (raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start > 0 && end > start) {
    const inner = text.slice(start + 1, end).trim();
    try {
      return JSON.parse(inner);
    } catch {}
  }
  return null;
}

async function readJsonOrJsonp(res: Response): Promise<unknown | null> {
  const text = await res.text();
  return parseJsonOrJsonp(text);
}

function toFiniteInt(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function isNaverNewsArticleUrl(sourceUrl: string): boolean {
  try {
    const u = new URL(sourceUrl);
    if (!/(^|\.)news\.naver\.com$/i.test(u.host)) return false;
    return /\/article(\/comment)?\//.test(u.pathname) || (u.searchParams.has("oid") && u.searchParams.has("aid"));
  } catch {
    return false;
  }
}

function parseNaverArticleIds(sourceUrl: string): { oid: string; aid: string } | null {
  try {
    const u = new URL(sourceUrl);
    const fromPath = u.pathname.match(/\/article(?:\/comment)?\/(\d+)\/(\d+)/);
    if (fromPath) {
      return { oid: fromPath[1], aid: fromPath[2] };
    }
    const oid = normalizeWhitespace(u.searchParams.get("oid") || "");
    const aid = normalizeWhitespace(u.searchParams.get("aid") || "");
    if (oid && aid) return { oid, aid };
  } catch {}
  return null;
}

function extractJsonObjectAfterMarker(text: string, marker: string): string | null {
  const markerIdx = text.indexOf(marker);
  if (markerIdx < 0) return null;
  const start = text.indexOf("{", markerIdx);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function normalizeNaverSort(sortMode: string, fallbackSort: string): string {
  const s = (sortMode || "").trim().toLowerCase();
  if (s.includes("new") || s.includes("latest") || s.includes("최신")) return "NEW";
  if (s.includes("old") || s.includes("오래") || s.includes("과거")) return "OLD";
  if (s.includes("reply") || s.includes("답글")) return "REPLY";
  if (s.includes("relative") || s.includes("관련")) return "RELATIVE";
  if (s.includes("favorite") || s.includes("popular") || s.includes("공감") || s.includes("인기")) return "FAVORITE";
  const fb = (fallbackSort || "").trim().toUpperCase();
  return ["FAVORITE", "NEW", "RELATIVE", "REPLY", "OLD"].includes(fb) ? fb : "FAVORITE";
}

function buildNaverCv(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(
    d.getSeconds(),
  )}`;
}

type NaverCboxConfig = {
  apiDomain: string;
  ticket: string;
  templateId: string;
  objectId: string;
  language: string;
  country: string;
  pageSize: number;
  replyPageSize: number;
  pageType: string;
  pool: string;
  defaultSort: string;
  articleReferrer: string;
  commentPageUrl: string;
};

async function loadNaverCboxConfig(cfg: RuntimeConfig): Promise<NaverCboxConfig | null> {
  const ids = parseNaverArticleIds(cfg.sourceUrl);
  if (!ids) return null;

  const baseApiDomain = "https://apis.naver.com/commentBox/cbox5";
  const defaultObjectId = `news${ids.oid},${ids.aid}`;
  const articleReferrer = `https://n.news.naver.com/article/${ids.oid}/${ids.aid}`;
  const commentPageUrl = `https://n.news.naver.com/article/comment/${ids.oid}/${ids.aid}`;

  const headers = headersFromConfig(cfg);
  if (!headers.referer) headers.referer = articleReferrer;

  const defaults: NaverCboxConfig = {
    apiDomain: baseApiDomain,
    ticket: "news",
    templateId: "view_economy_m1",
    objectId: defaultObjectId,
    language: "ko",
    country: "KR",
    pageSize: 20,
    replyPageSize: 20,
    pageType: "more",
    pool: "cbox5",
    defaultSort: "FAVORITE",
    articleReferrer,
    commentPageUrl,
  };

  const res = await fetchWithRetry(
    cfg.sourceUrl,
    { method: "GET", headers },
    cfg.maxRetries,
    cfg.retryBackoffSec,
  );
  if (!res || res.status >= 400) {
    return defaults;
  }
  const html = await res.text();
  const objText = extractJsonObjectAfterMarker(html, "window.__htCboxOption");
  if (!objText) return defaults;

  let rec: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(objText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      rec = parsed as Record<string, unknown>;
    } else {
      return defaults;
    }
  } catch {
    return defaults;
  }

  const apiDomainRaw = normalizeWhitespace(String(rec.sApiDomain || defaults.apiDomain)).replace(/\/+$/, "");
  const apiDomain = apiDomainRaw || defaults.apiDomain;
  const apiDomainParts = apiDomain.split("/");
  const inferredPool = normalizeWhitespace(apiDomainParts[apiDomainParts.length - 1]);

  return {
    apiDomain,
    ticket: normalizeWhitespace(String(rec.sTicket || defaults.ticket)) || defaults.ticket,
    templateId: normalizeWhitespace(String(rec.sTemplateId || defaults.templateId)) || defaults.templateId,
    objectId: normalizeWhitespace(String(rec.sObjectId || defaults.objectId)) || defaults.objectId,
    language: normalizeWhitespace(String(rec.sLanguage || defaults.language)) || defaults.language,
    country: normalizeWhitespace(String(rec.sCountry || defaults.country)) || defaults.country,
    pageSize: Math.max(1, Math.min(100, toFiniteInt(rec.nUserCommentPageSize ?? rec.nPageSize, defaults.pageSize))),
    replyPageSize: Math.max(
      1,
      Math.min(100, toFiniteInt(rec.nReplyPageSize ?? rec.nUserCommentReplyPageSize, defaults.replyPageSize)),
    ),
    pageType: normalizeWhitespace(String(rec.sPageType || defaults.pageType)) || defaults.pageType,
    pool: normalizeWhitespace(String(rec.pool || inferredPool || defaults.pool)) || defaults.pool,
    defaultSort: normalizeNaverSort(String(rec.sSort || defaults.defaultSort), defaults.defaultSort),
    articleReferrer,
    commentPageUrl,
  };
}

function mapNaverCommentRow(input: {
  cfg: RuntimeConfig;
  row: Record<string, unknown>;
  pageNum: number;
  sort: string;
  commentUrl: string;
  sinceDate: Date | null;
  seenExternalIds: Set<string>;
  parentHint?: string;
  sourceType?: string;
}): CrawledComment | null {
  const content = normalizeWhitespace(String(input.row.contents || ""));
  const author = normalizeWhitespace(
    String(input.row.maskedUserId || input.row.maskedUserName || input.row.userName || input.row.userIdNo || ""),
  );
  const dtRaw = String(input.row.modTime || input.row.regTime || input.row.modTimeGmt || input.row.regTimeGmt || "");
  const publishedIso = parseDateToIso(dtRaw, input.cfg.defaultTimezoneOffsetHours);
  if (input.sinceDate && publishedIso) {
    const d = new Date(publishedIso);
    if (!Number.isNaN(d.getTime()) && d <= input.sinceDate) return null;
  }

  const deletedByFlag =
    Boolean(input.row.deleted) || Boolean(input.row.blind) || Number(input.row.status ?? 0) < 0;
  const deletedByText = detectDeleted(content, input.cfg.deletedMarkersCsv);
  const isDeleted = deletedByFlag || deletedByText;
  if (!isDeleted && content.length < input.cfg.minCommentLength) return null;

  let externalId = normalizeWhitespace(String(input.row.commentNo || ""));
  const replyLevel = toFiniteInt(input.row.replyLevel, 1);
  const parentRaw = normalizeWhitespace(String(input.row.parentCommentNo || ""));
  const parentId = normalizeWhitespace(input.parentHint || parentRaw);
  const isReply = Boolean(input.parentHint) || replyLevel >= 2 || (parentRaw && parentRaw !== externalId);
  if (!externalId) {
    externalId = stableSha1(
      `${input.cfg.sourceUrl}|${parentId}|${input.pageNum}|${author}|${publishedIso || ""}|${content}`,
    );
  }
  if (input.seenExternalIds.has(externalId)) return null;
  input.seenExternalIds.add(externalId);

  const parentExternalId = isReply ? parentId || null : null;
  const contentHash = stableSha1(`${input.cfg.sourceUrl}|${externalId}|${author}|${publishedIso || ""}|${content}`);

  return {
    source_url: input.cfg.sourceUrl,
    external_id: externalId,
    parent_external_id: parentExternalId,
    content,
    pii_masked_content: "",
    author: author || null,
    comment_url: input.commentUrl,
    published_at: publishedIso,
    status: isDeleted ? "deleted" : "active",
    is_spam: false,
    source_type: input.sourceType || "api_json_naver",
    metadata: {
      collected_at: new Date().toISOString(),
      sort_mode: input.sort,
      page_num: input.pageNum,
      reply_level: replyLevel,
      naver_parent_comment_no: parentRaw || null,
      naver_reply_count: toFiniteInt(input.row.replyCount, 0),
    },
    content_hash: contentHash,
  };
}

async function fetchNaverListJsonp(input: {
  cfg: RuntimeConfig;
  cbox: NaverCboxConfig;
  pageNum: number;
  sort: string;
  pageSize: number;
  parentCommentNo?: string;
}): Promise<Record<string, unknown> | null> {
  const url = new URL(`${input.cbox.apiDomain}/web_naver_list_jsonp.json`);
  url.searchParams.set("ticket", input.cbox.ticket);
  url.searchParams.set("templateId", input.cbox.templateId);
  url.searchParams.set("pool", input.cbox.pool);
  url.searchParams.set("_cv", buildNaverCv());
  url.searchParams.set("lang", input.cbox.language);
  url.searchParams.set("country", input.cbox.country);
  url.searchParams.set("objectId", input.cbox.objectId);
  url.searchParams.set("pageSize", String(Math.max(1, input.pageSize)));
  url.searchParams.set("indexSize", "10");
  url.searchParams.set("pageType", input.cbox.pageType);
  url.searchParams.set("page", String(Math.max(1, input.pageNum)));
  url.searchParams.set("sort", input.sort);
  if (input.parentCommentNo) {
    url.searchParams.set("parentCommentNo", input.parentCommentNo);
  }

  const headers = headersFromConfig(input.cfg);
  if (!headers.referer) headers.referer = input.cbox.articleReferrer;

  const res = await fetchWithRetry(
    url.toString(),
    { method: "GET", headers },
    input.cfg.maxRetries,
    input.cfg.retryBackoffSec,
  );
  if (!res || res.status >= 400) return null;
  const payload = await readJsonOrJsonp(res);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

async function crawlNaverNewsApi(
  cfg: RuntimeConfig,
  sinceDate: Date | null,
): Promise<{ comments: CrawledComment[]; report: CrawlReport }> {
  const cbox = await loadNaverCboxConfig(cfg);
  if (!cbox) {
    return {
      comments: [],
      report: {
        pagesScanned: 0,
        commentsFound: 0,
        commentsKept: 0,
        modeUsed: "api_json_naver",
        notes: "네이버 기사 URL에서 oid/aid를 파싱하지 못했습니다.",
        lastCursor: null,
      },
    };
  }

  const sort = normalizeNaverSort(cfg.sortMode, cbox.defaultSort);
  const seenExternalIds = new Set<string>();
  const comments: CrawledComment[] = [];
  const notes: string[] = [];
  let expectedTotal = 0;
  let pagesScanned = 0;
  let commentsFound = 0;

  for (let i = 0; i < cfg.maxPages; i += 1) {
    const pageNum = cfg.pageStart + i;
    const payload = await fetchNaverListJsonp({
      cfg,
      cbox,
      pageNum,
      sort,
      pageSize: cbox.pageSize,
    });
    pagesScanned += 1;
    if (!payload) {
      notes.push(`네이버 본댓글 API 응답 파싱 실패 (page=${pageNum})`);
      break;
    }

    const ok = payload.success === true || String(payload.code || "") === "1000";
    if (!ok) {
      notes.push(`네이버 API 실패 code=${String(payload.code || "")} msg=${String(payload.message || "")}`);
      break;
    }

    const result = getByPath(payload, "result");
    const rowList = Array.isArray(getByPath(result, "commentList")) ? (getByPath(result, "commentList") as unknown[]) : [];
    commentsFound += rowList.length;
    if (!expectedTotal) {
      expectedTotal = Math.max(0, toFiniteInt(getByPath(result, "count.comment"), 0));
    }

    for (const row of rowList) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const mapped = mapNaverCommentRow({
        cfg,
        row: rec,
        pageNum,
        sort,
        commentUrl: cbox.commentPageUrl,
        sinceDate,
        seenExternalIds,
      });
      if (mapped) comments.push(mapped);
    }

    const parentCandidates = rowList.filter(
      (row) => row && typeof row === "object" && toFiniteInt((row as Record<string, unknown>).replyCount, 0) > 0,
    ) as Record<string, unknown>[];

    for (const parent of parentCandidates) {
      const parentCommentNo = normalizeWhitespace(String(parent.commentNo || ""));
      if (!parentCommentNo) continue;
      const replyCount = Math.max(0, toFiniteInt(parent.replyCount, 0));
      if (!replyCount) continue;

      const plannedReplyPages = Math.max(1, Math.ceil(replyCount / Math.max(1, cbox.replyPageSize)));
      const maxReplyPages = Math.min(50, plannedReplyPages);

      for (let rp = 1; rp <= maxReplyPages; rp += 1) {
        const replyPayload = await fetchNaverListJsonp({
          cfg,
          cbox,
          pageNum: rp,
          sort: "OLD",
          pageSize: cbox.replyPageSize,
          parentCommentNo,
        });
        pagesScanned += 1;
        if (!replyPayload) {
          notes.push(`대댓글 API 응답 파싱 실패 (parent=${parentCommentNo}, page=${rp})`);
          break;
        }

        const replyOk = replyPayload.success === true || String(replyPayload.code || "") === "1000";
        if (!replyOk) {
          notes.push(
            `대댓글 API 실패 parent=${parentCommentNo} code=${String(replyPayload.code || "")} msg=${String(replyPayload.message || "")}`,
          );
          break;
        }

        const replyResult = getByPath(replyPayload, "result");
        const replyRows = Array.isArray(getByPath(replyResult, "commentList"))
          ? (getByPath(replyResult, "commentList") as unknown[])
          : [];
        commentsFound += replyRows.length;
        let addedThisReplyPage = 0;

        for (const rr of replyRows) {
          if (!rr || typeof rr !== "object") continue;
          const rec = rr as Record<string, unknown>;
          if (normalizeWhitespace(String(rec.commentNo || "")) === parentCommentNo) continue;
          const mapped = mapNaverCommentRow({
            cfg,
            row: rec,
            pageNum: rp,
            sort: "OLD",
            commentUrl: cbox.commentPageUrl,
            sinceDate,
            seenExternalIds,
            parentHint: parentCommentNo,
          });
          if (mapped) {
            comments.push(mapped);
            addedThisReplyPage += 1;
          }
        }

        const replyTotalPages = toFiniteInt(getByPath(replyResult, "pageModel.totalPages"), 0);
        if (replyRows.length === 0) break;
        if (replyTotalPages > 0 && rp >= replyTotalPages) break;
        if (addedThisReplyPage === 0) break;

        if (cfg.requestDelaySec > 0) {
          await sleep(Math.floor(cfg.requestDelaySec * 1000));
        }
      }
    }

    const totalPages = toFiniteInt(getByPath(result, "pageModel.totalPages"), 0);
    if (rowList.length === 0) break;
    if (totalPages > 0 && pageNum >= totalPages) break;

    if (cfg.requestDelaySec > 0) {
      await sleep(Math.floor(cfg.requestDelaySec * 1000));
    }
  }

  if (!comments.length) {
    notes.push("네이버 댓글 수집 결과가 0건입니다. 페이지 접근 권한/정책 또는 파라미터를 확인하세요.");
  } else if (expectedTotal > 0 && comments.length < expectedTotal) {
    notes.push(`예상 댓글수(${expectedTotal}) 대비 수집수(${comments.length})가 적습니다. Max Pages/정렬/접근정책을 확인하세요.`);
  } else if (expectedTotal > 0) {
    notes.push(`예상 댓글수(${expectedTotal}) 기준으로 ${comments.length}건 수집했습니다.`);
  }

  return {
    comments,
    report: {
      pagesScanned,
      commentsFound,
      commentsKept: comments.length,
      modeUsed: "api_json_naver",
      notes: notes.join(" ").slice(0, 500),
      lastCursor: null,
    },
  };
}

function extractFromHtml(
  html: string,
  pageUrl: string,
  cfg: RuntimeConfig,
  sinceDate: Date | null,
  seenExternalIds: Set<string>,
  nextSelectorOverride?: string,
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
  const nextSelector = (nextSelectorOverride || cfg.nextPageSelector || "").trim();
  if (nextSelector) {
    $(nextSelector).each((_, el) => {
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

function splitCsv(raw: string): string[] {
  return (raw || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function compileSafeRegex(raw: string): RegExp | null {
  const text = (raw || "").trim();
  if (!text) return null;
  try {
    return new RegExp(text, "i");
  } catch {
    return null;
  }
}

function isLikelyHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function shouldKeepPostUrl(url: string, cfg: RuntimeConfig, postRegex: RegExp | null, includes: string[]): boolean {
  if (!isSameDomain(cfg.sourceUrl, url)) return false;
  if (includes.length) {
    const low = url.toLowerCase();
    const ok = includes.some((kw) => low.includes(kw.toLowerCase()));
    if (!ok) return false;
  }
  if (postRegex && !postRegex.test(url)) return false;
  return true;
}

function extractPostLinksFromListHtml(
  html: string,
  listPageUrl: string,
  cfg: RuntimeConfig,
  postRegex: RegExp | null,
  includes: string[],
): { postUrls: string[]; nextListUrls: string[] } {
  const $ = cheerio.load(html);
  const postUrls: string[] = [];
  const seenPost = new Set<string>();
  const linkSelector = (cfg.postLinkSelector || "").trim();

  if (linkSelector) {
    $(linkSelector).each((_, el) => {
      const href = ($(el).attr("href") || "").trim();
      if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) return;
      try {
        const abs = new URL(href, listPageUrl).toString();
        if (!isLikelyHttpUrl(abs)) return;
        if (!shouldKeepPostUrl(abs, cfg, postRegex, includes)) return;
        if (!seenPost.has(abs)) {
          seenPost.add(abs);
          postUrls.push(abs);
        }
      } catch {}
    });
  }

  const nextListUrls: string[] = [];
  const seenNext = new Set<string>();
  const nextSel = (cfg.listNextPageSelector || cfg.nextPageSelector || "").trim();
  if (nextSel) {
    $(nextSel).each((_, el) => {
      const href = ($(el).attr("href") || "").trim();
      if (!href) return;
      try {
        const abs = new URL(href, listPageUrl).toString();
        if (!isSameDomain(cfg.sourceUrl, abs)) return;
        if (!seenNext.has(abs)) {
          seenNext.add(abs);
          nextListUrls.push(abs);
        }
      } catch {}
    });
  }
  return { postUrls, nextListUrls };
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

async function crawlStaticListToPosts(
  cfg: RuntimeConfig,
  sinceDate: Date | null,
): Promise<{ comments: CrawledComment[]; report: CrawlReport }> {
  const headers = headersFromConfig(cfg);
  const postRegex = compileSafeRegex(cfg.postUrlRegex);
  const includes = splitCsv(cfg.postUrlIncludes);
  const seenExternalIds = new Set<string>();

  const listVisited = new Set<string>();
  const selectedPostUrls: string[] = [];
  const selectedPostSet = new Set<string>();
  const notes: string[] = [];
  let pagesScanned = 0;
  let commentsFound = 0;

  const listQueue: string[] = cfg.pageParamName
    ? Array.from({ length: cfg.maxPages }, (_, i) => setPageParam(cfg.sourceUrl, cfg.pageParamName, cfg.pageStart + i))
    : [cfg.sourceUrl];

  while (listQueue.length && listVisited.size < cfg.maxPages && selectedPostUrls.length < cfg.maxPosts) {
    const listPageUrl = listQueue.shift() as string;
    if (listVisited.has(listPageUrl)) continue;
    listVisited.add(listPageUrl);
    pagesScanned += 1;

    const res = await fetchWithRetry(
      listPageUrl,
      { method: "GET", headers },
      cfg.maxRetries,
      cfg.retryBackoffSec,
    );
    if (!res || res.status >= 400) {
      notes.push(`목록 페이지 요청 실패: ${listPageUrl}`);
      continue;
    }
    const html = await res.text();
    const { postUrls, nextListUrls } = extractPostLinksFromListHtml(html, listPageUrl, cfg, postRegex, includes);

    for (const postUrl of postUrls) {
      if (selectedPostSet.has(postUrl)) continue;
      selectedPostSet.add(postUrl);
      selectedPostUrls.push(postUrl);
      if (selectedPostUrls.length >= cfg.maxPosts) break;
    }

    for (const nextListUrl of nextListUrls) {
      if (!listVisited.has(nextListUrl)) listQueue.push(nextListUrl);
    }

    if (cfg.requestDelaySec > 0) {
      await sleep(Math.floor(cfg.requestDelaySec * 1000));
    }
  }

  const comments: CrawledComment[] = [];
  for (const postUrl of selectedPostUrls) {
    const commentVisited = new Set<string>();
    const commentQueue: string[] = [postUrl];

    while (commentQueue.length && commentVisited.size < cfg.maxCommentPagesPerPost) {
      const pageUrl = commentQueue.shift() as string;
      if (commentVisited.has(pageUrl)) continue;
      commentVisited.add(pageUrl);
      pagesScanned += 1;

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
        cfg.commentNextPageSelector || cfg.nextPageSelector,
      );
      commentsFound += found;
      comments.push(...extracted);

      for (const nextUrl of nextLinks) {
        if (!commentVisited.has(nextUrl)) commentQueue.push(nextUrl);
      }
      if (cfg.requestDelaySec > 0) {
        await sleep(Math.floor(cfg.requestDelaySec * 1000));
      }
    }
  }

  if (!selectedPostUrls.length) {
    notes.push(`게시글 링크를 찾지 못했습니다. postLinkSelector="${cfg.postLinkSelector}"`);
  } else {
    notes.push(`목록에서 게시글 ${selectedPostUrls.length}개를 수집해 댓글 페이지를 순회했습니다.`);
  }

  return {
    comments,
    report: {
      pagesScanned,
      commentsFound,
      commentsKept: comments.length,
      modeUsed: "static_list_posts",
      notes: notes.join(" ").slice(0, 500),
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
  } as Record<string, string>;
  if (!headers.referer) headers.referer = cfg.sourceUrl;

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

    const json = await readJsonOrJsonp(res);
    if (!json) break;

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
  let naverError = "";
  if (isNaverNewsArticleUrl(cfg.sourceUrl)) {
    try {
      return await crawlNaverNewsApi(cfg, sinceDate);
    } catch (err) {
      naverError = `네이버 전용 수집 실패: ${err instanceof Error ? err.message : "unknown"}`;
    }
  }

  if (cfg.crawlMode === "api_json") {
    const out = await crawlApiJson(cfg, sinceDate);
    if (naverError) out.report.notes = `${naverError} | ${out.report.notes}`.slice(0, 500);
    return out;
  }
  if (cfg.collectionMode === "list_to_posts") {
    const out = await crawlStaticListToPosts(cfg, sinceDate);
    if (cfg.crawlMode === "dynamic") {
      out.report.notes = `dynamic mode is not supported on Vercel serverless. Fell back to static list mode. ${out.report.notes}`.slice(
        0,
        500,
      );
    }
    if (naverError) out.report.notes = `${naverError} | ${out.report.notes}`.slice(0, 500);
    return out;
  }
  if (cfg.crawlMode === "dynamic") {
    const fallback = await crawlStatic(cfg, sinceDate);
    fallback.report.modeUsed = "static";
    fallback.report.notes = "dynamic mode is not supported on Vercel serverless. Fell back to static mode.";
    if (naverError) fallback.report.notes = `${naverError} | ${fallback.report.notes}`.slice(0, 500);
    return fallback;
  }
  const out = await crawlStatic(cfg, sinceDate);
  if (naverError) out.report.notes = `${naverError} | ${out.report.notes}`.slice(0, 500);
  return out;
}
