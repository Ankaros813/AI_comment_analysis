import { createClient } from "@supabase/supabase-js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

export function getSupabaseClient() {
  const url = requiredEnv("SUPABASE_HACKERTHON_URL");
  const key = requiredEnv("SUPABASE_HACKERTHON_SERVICE_ROLE_KEY");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function getCrawlState(input: {
  sourceUrl: string;
  crawlScope: string;
  sortMode: string;
}) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("crawl_state")
    .select("source_url,crawl_scope,sort_mode,last_crawled_at,last_cursor,last_run_status,updated_at")
    .eq("source_url", input.sourceUrl)
    .eq("crawl_scope", input.crawlScope)
    .eq("sort_mode", input.sortMode)
    .limit(1);
  if (error) throw error;
  if (!data || !data.length) return null;
  return data[0];
}

export async function upsertCrawlState(input: {
  sourceUrl: string;
  crawlScope: string;
  sortMode: string;
  lastCrawledAt: string;
  lastCursor?: string | null;
  lastRunStatus?: string | null;
}) {
  const supabase = getSupabaseClient();
  const row = {
    source_url: input.sourceUrl,
    crawl_scope: input.crawlScope,
    sort_mode: input.sortMode,
    last_crawled_at: input.lastCrawledAt,
    last_cursor: input.lastCursor || null,
    last_run_status: input.lastRunStatus || null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("crawl_state").upsert(row, {
    onConflict: "source_url,crawl_scope,sort_mode",
  });
  if (error) throw error;
}

export async function upsertDocuments(rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const supabase = getSupabaseClient();
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from("documents").upsert(chunk, {
      onConflict: "source_url,external_id",
    });
    if (error) throw error;
  }
}

export async function fetchDocumentsByExternalIds(sourceUrl: string, externalIds: string[]) {
  if (!externalIds.length) return [];
  const supabase = getSupabaseClient();
  const collected: Record<string, unknown>[] = [];
  const chunkSize = 150;
  for (let i = 0; i < externalIds.length; i += chunkSize) {
    const chunk = externalIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("documents")
      .select(
        "id,source_url,crawl_scope,sort_mode,external_id,parent_external_id,content,pii_masked_content,author,comment_url,published_at,status,is_spam,source_type,metadata,content_hash,last_seen_at",
      )
      .eq("source_url", sourceUrl)
      .in("external_id", chunk);
    if (error) throw error;
    if (data?.length) collected.push(...(data as Record<string, unknown>[]));
  }
  return collected;
}

export async function fetchEmbeddingHashMap(documentIds: string[]) {
  if (!documentIds.length) return new Map<string, string>();
  const supabase = getSupabaseClient();
  const hashMap = new Map<string, string>();
  const chunkSize = 200;
  for (let i = 0; i < documentIds.length; i += chunkSize) {
    const chunk = documentIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("comment_embeddings")
      .select("document_id,content_hash")
      .in("document_id", chunk);
    if (error) throw error;
    for (const row of data || []) {
      if (row?.document_id) hashMap.set(String(row.document_id), String(row.content_hash || ""));
    }
  }
  return hashMap;
}

export async function upsertEmbeddings(rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const supabase = getSupabaseClient();
  // Vector payloads are large; batch writes to avoid PostgREST payload/time limits.
  const chunkSize = 24;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from("comment_embeddings").upsert(chunk, {
      onConflict: "document_id",
    });
    if (error) {
      const parts = [error.message || "Embedding upsert failed"];
      if (error.code) parts.push(`code=${error.code}`);
      if (error.details) parts.push(`details=${error.details}`);
      if (error.hint) parts.push(`hint=${error.hint}`);
      throw new Error(parts.join(" | "));
    }
  }
}

export async function searchSimilarDocuments(input: {
  sourceUrl: string;
  crawlScope: string;
  sortMode: string;
  queryEmbeddingLiteral: string;
  topK: number;
  excludeDeleted: boolean;
  excludeSpam: boolean;
}) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("match_comment_embeddings", {
    query_embedding: input.queryEmbeddingLiteral,
    match_source_url: input.sourceUrl,
    match_crawl_scope: input.crawlScope,
    match_sort_mode: input.sortMode,
    match_count: input.topK,
    filter_exclude_deleted: input.excludeDeleted,
    filter_exclude_spam: input.excludeSpam,
  });
  if (error) throw error;
  return data || [];
}

export async function fetchRecentDocuments(input: {
  sourceUrl: string;
  crawlScope: string;
  sortMode: string;
  topK: number;
  excludeDeleted: boolean;
  excludeSpam: boolean;
}) {
  const supabase = getSupabaseClient();
  let query = supabase
    .from("documents")
    .select(
      "id,content,pii_masked_content,author,comment_url,published_at,status,is_spam,metadata,content_hash,last_seen_at",
    )
    .eq("source_url", input.sourceUrl)
    .eq("crawl_scope", input.crawlScope)
    .eq("sort_mode", input.sortMode)
    .order("published_at", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .limit(input.topK);

  if (input.excludeDeleted) query = query.eq("status", "active");
  if (input.excludeSpam) query = query.eq("is_spam", false);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}
