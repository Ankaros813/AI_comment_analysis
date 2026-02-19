import crypto from "crypto";

const DEFAULT_EMBED_MODEL = "openai/text-embedding-3-small";
const DEFAULT_LOCAL_DIM = 1536;

function normalizeForEmbedding(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function hashEmbedding(text: string, dim = DEFAULT_LOCAL_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = normalizeForEmbedding(text).toLowerCase().match(/[a-z0-9\uac00-\ud7a3]+/g) || [];
  if (!tokens.length) return vec;

  for (const token of tokens.slice(0, 240)) {
    const digest = crypto.createHash("sha256").update(token).digest();
    const idx = digest.readUInt32LE(0) % dim;
    const sign = digest[4] % 2 === 0 ? 1 : -1;
    vec[idx] += sign;
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
  }
  return vec;
}

export function embedTextsLocal(input: {
  texts: string[];
  dim?: number;
}) {
  const dim = Math.max(1, Math.min(8192, Number(input.dim || DEFAULT_LOCAL_DIM)));
  return input.texts.map((t) => hashEmbedding(t, dim));
}

export async function embedTextsWithOpenRouter(input: {
  apiKey: string;
  texts: string[];
  timeoutMs: number;
  modelName?: string;
  batchSize?: number;
  expectedDim?: number;
}) {
  const modelName = (input.modelName || process.env.COMMENT_EMBEDDING_MODEL || DEFAULT_EMBED_MODEL).trim();
  const batchSize = Math.max(1, Math.min(128, input.batchSize || 48));
  const parsedExpectedDim = Number(input.expectedDim || process.env.COMMENT_EMBEDDING_DIM || "1536");
  const expectedDim = Number.isFinite(parsedExpectedDim) && parsedExpectedDim > 0 ? Math.trunc(parsedExpectedDim) : 0;
  const texts = input.texts.map((t) => normalizeForEmbedding(t));
  if (!texts.length) return [] as number[][];

  const result: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
          "http-referer": "https://localhost.ai-comment-analysis",
          "x-title": "AI Comment Analysis Embedding",
        },
        body: JSON.stringify({
          model: modelName,
          input: batch,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenRouter embeddings failed (${res.status}): ${body.slice(0, 280)}`);
      }
      const payload = (await res.json()) as {
        data?: Array<{ index?: number; embedding?: number[] }>;
      };
      const rows = (payload.data || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
      if (rows.length !== batch.length) {
        throw new Error(`Embedding count mismatch: expected ${batch.length}, got ${rows.length}`);
      }
      for (const row of rows) {
        const embedding = row.embedding || [];
        if (!embedding.length) throw new Error("OpenRouter embeddings returned empty vector.");
        if (expectedDim > 0 && embedding.length !== expectedDim) {
          throw new Error(`Embedding dimension mismatch: expected ${expectedDim}, got ${embedding.length}`);
        }
        result.push(embedding.map((v) => Number(v)));
      }
    } finally {
      clearTimeout(id);
    }
  }
  return result;
}

export function vectorLiteral(vec: number[]): string {
  return `[${vec.map((v) => Number(v.toFixed(7))).join(",")}]`;
}
