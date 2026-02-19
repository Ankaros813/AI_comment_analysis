import crypto from "crypto";

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /\b(?:\+?\d{1,3}[-.\s]?)?(?:\d{2,4}[-.\s]?){2,4}\d{2,4}\b/g;
const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;
const LONG_NUMBER_RE = /\b\d{8,}\b/g;
const REPEAT_RE = /(.)\1{7,}/;

export const DEFAULT_DELETED_MARKERS = [
  "[deleted]",
  "삭제된 댓글",
  "삭제됨",
  "deleted by user",
  "removed",
];

export const DEFAULT_SPAM_KEYWORDS = [
  "무료",
  "수익",
  "클릭",
  "dm",
  "텔레그램",
  "바카라",
  "bit.ly",
  "investment",
  "casino",
  "loan",
  "earn money",
];

export function normalizeWhitespace(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

export function csvToSet(raw: string): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function maskPII(text: string): string {
  let output = text || "";
  output = output.replace(EMAIL_RE, "[EMAIL]");
  output = output.replace(PHONE_RE, "[PHONE]");
  output = output.replace(URL_RE, "[URL]");
  output = output.replace(LONG_NUMBER_RE, "[NUMBER]");
  return output;
}

export function detectDeleted(content: string, markersCsv: string): boolean {
  const text = normalizeWhitespace(content).toLowerCase();
  if (!text) return false;
  const markers = new Set(DEFAULT_DELETED_MARKERS.map((v) => v.toLowerCase()));
  for (const v of csvToSet(markersCsv)) markers.add(v);
  for (const marker of markers) {
    if (marker && text.includes(marker)) return true;
  }
  return false;
}

export function isProbableSpam(
  content: string,
  author: string | null | undefined,
  spamKeywordsCsv: string,
): boolean {
  const text = normalizeWhitespace(content).toLowerCase();
  if (!text) return false;

  if (REPEAT_RE.test(text)) return true;
  if ((text.match(/https?:\/\/|www\./gi) || []).length >= 2) return true;

  const keywords = new Set(DEFAULT_SPAM_KEYWORDS.map((v) => v.toLowerCase()));
  for (const v of csvToSet(spamKeywordsCsv)) keywords.add(v);
  let hits = 0;
  for (const k of keywords) {
    if (k && text.includes(k)) hits += 1;
    if (hits >= 2) return true;
  }

  const authorLower = (author || "").toLowerCase();
  if (authorLower.includes("bot") || authorLower.includes("marketing")) return true;

  return false;
}

export function parseDateToIso(raw: string, defaultTzOffsetHours: number): string | null {
  const text = normalizeWhitespace(raw);
  if (!text) return null;
  const absolute = new Date(text);
  if (!Number.isNaN(absolute.getTime())) {
    return absolute.toISOString();
  }

  const now = new Date();
  const rel = [
    { re: /(\d+)\s*초\s*전/i, ms: 1000 },
    { re: /(\d+)\s*분\s*전/i, ms: 60_000 },
    { re: /(\d+)\s*시간\s*전/i, ms: 3_600_000 },
    { re: /(\d+)\s*일\s*전/i, ms: 86_400_000 },
    { re: /(\d+)\s*week[s]?\s*ago/i, ms: 7 * 86_400_000 },
    { re: /(\d+)\s*day[s]?\s*ago/i, ms: 86_400_000 },
    { re: /(\d+)\s*hour[s]?\s*ago/i, ms: 3_600_000 },
    { re: /(\d+)\s*min(?:ute)?s?\s*ago/i, ms: 60_000 },
  ];
  if (/^(방금|just now)$/i.test(text)) return now.toISOString();
  if (/^(어제|yesterday)$/i.test(text)) {
    return new Date(now.getTime() - 86_400_000).toISOString();
  }
  for (const item of rel) {
    const m = text.match(item.re);
    if (!m) continue;
    return new Date(now.getTime() - Number(m[1]) * item.ms).toISOString();
  }

  // fallback: interpret as local-like time with provided offset
  const parsed = Date.parse(text + ` GMT${defaultTzOffsetHours >= 0 ? "+" : ""}${defaultTzOffsetHours}`);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return null;
}

export function stableSha1(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

