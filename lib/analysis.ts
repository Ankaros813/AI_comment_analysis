import type { CrawlInstructionPlan } from "./types";

const SYSTEM_PROMPT = `
당신은 실시간 댓글 인텔리전스 분석가입니다.
반드시 한국어로만 답변하세요.
Markdown 형식으로 아래 섹션을 순서대로 작성하세요:
## 1) 핵심 요약
## 2) 실시간 감성 스냅샷
## 3) 주요 토픽 (Top 5)
## 4) 리스크 알림
## 5) 전환/수익 관점 실행 액션
## 6) 7일 실행 계획
요구사항:
- 문장은 짧고 의사결정에 바로 쓸 수 있게 작성
- 근거가 되는 댓글은 [1], [2] 형태로 번호 인용
- 데이터가 부족하면 추정하지 말고 부족하다고 명시
`.trim();

const CRAWL_PLANNER_SYSTEM_PROMPT = `
You are a strict JSON planner for comment crawling.
Convert the user instruction into JSON only.
Allowed JSON schema:
{
  "apply_filter": boolean,
  "start_date": "YYYY-MM-DD" | null,
  "end_date": "YYYY-MM-DD" | null,
  "target_comment_count": number | null,
  "recommended_max_pages": number | null,
  "recommended_lookback_hours": number | null,
  "rationale": string
}
Rules:
- If no clear date range, set start_date/end_date to null.
- If no clear comment count, set target_comment_count to null.
- Keep numbers realistic.
- Return only JSON, no markdown.
`.trim();

const POSITIVE_HINTS = [
  "good",
  "great",
  "love",
  "excellent",
  "nice",
  "추천",
  "만족",
  "좋다",
  "최고",
];

const NEGATIVE_HINTS = [
  "bad",
  "worst",
  "hate",
  "terrible",
  "bug",
  "불만",
  "별로",
  "최악",
  "실망",
  "문제",
];

const STOPWORDS = new Set([
  "and",
  "the",
  "this",
  "that",
  "with",
  "from",
  "for",
  "have",
  "has",
  "you",
  "they",
  "그리고",
  "하지만",
  "그냥",
  "진짜",
  "정말",
  "이번",
  "너무",
]);

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function toValidDateOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(`${t}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : t;
}

function toNumberOrNull(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const x = Math.trunc(n);
  if (x < min || x > max) return null;
  return x;
}

export function buildContextBlock(
  docs: Record<string, unknown>[],
  maxChars: number,
  useMasked: boolean,
): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < docs.length; i += 1) {
    const d = docs[i];
    const content = String((useMasked ? d.pii_masked_content : d.content) || d.content || "").trim();
    const author = String(d.author || "anonymous");
    const publishedAt = String(d.published_at || "time_unknown");
    const line = `[${i + 1}] (${publishedAt}) @${author}: ${content}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length ? lines.join("\n") : "댓글 데이터가 충분하지 않습니다.";
}

export async function callOpenRouter(input: {
  apiKey: string;
  modelName: string;
  sourceUrl: string;
  userQuery: string;
  docs: Record<string, unknown>[];
  maxContextChars: number;
  timeoutMs: number;
  useMasked: boolean;
}) {
  const context = buildContextBlock(input.docs, input.maxContextChars, input.useMasked);
  const userPrompt = `
[Request]
${input.userQuery}

[Source URL]
${input.sourceUrl}

[Context comments]
${context}
`.trim();

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
        "http-referer": "https://localhost.ai-comment-analysis",
        "x-title": "AI Comment Analysis",
      },
      body: JSON.stringify({
        model: input.modelName,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 1200,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenRouter failed (${res.status}): ${body.slice(0, 280)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const output = data.choices?.[0]?.message?.content;
    if (!output) throw new Error("OpenRouter returned no content.");
    return output;
  } finally {
    clearTimeout(id);
  }
}

export async function planCrawlFromInstruction(input: {
  apiKey: string;
  modelName: string;
  sourceUrl: string;
  instruction: string;
  timeoutMs: number;
}): Promise<CrawlInstructionPlan | null> {
  const instruction = (input.instruction || "").trim();
  if (!instruction) return null;

  const userPrompt = `
[Source URL]
${input.sourceUrl}

[Instruction]
${instruction}

Return JSON only.
`.trim();

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
        "http-referer": "https://localhost.ai-comment-analysis",
        "x-title": "AI Comment Analysis Planner",
      },
      body: JSON.stringify({
        model: input.modelName,
        messages: [
          { role: "system", content: CRAWL_PLANNER_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 300,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content || "";
    const jsonRaw = extractJsonObject(content);
    if (!jsonRaw) return null;

    const parsed = JSON.parse(jsonRaw) as Record<string, unknown>;
    const plan: CrawlInstructionPlan = {
      applyFilter: Boolean(parsed.apply_filter),
      startDate: toValidDateOrNull(parsed.start_date),
      endDate: toValidDateOrNull(parsed.end_date),
      targetCommentCount: toNumberOrNull(parsed.target_comment_count, 1, 50000),
      recommendedMaxPages: toNumberOrNull(parsed.recommended_max_pages, 1, 200),
      recommendedLookbackHours: toNumberOrNull(parsed.recommended_lookback_hours, 0, 24 * 365),
      rationale: String(parsed.rationale || "").slice(0, 500),
    };
    return plan;
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

export function sentimentOf(text: string): "positive" | "neutral" | "negative" {
  const low = (text || "").toLowerCase();
  let pos = 0;
  let neg = 0;
  for (const w of POSITIVE_HINTS) if (low.includes(w)) pos += 1;
  for (const w of NEGATIVE_HINTS) if (low.includes(w)) neg += 1;
  if (pos > neg) return "positive";
  if (neg > pos) return "negative";
  return "neutral";
}

export function topKeywords(texts: string[], topN = 12): Array<{ keyword: string; count: number }> {
  const freq = new Map<string, number>();
  for (const t of texts) {
    const words = (t || "").toLowerCase().match(/[a-z0-9가-힣_]{2,}/g) || [];
    for (const w of words) {
      if (STOPWORDS.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([keyword, count]) => ({ keyword, count }));
}
