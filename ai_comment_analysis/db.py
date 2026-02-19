from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional

from dateutil import parser as dt_parser
from supabase import Client, create_client

from .config import AppConfig


def make_client(config: AppConfig, use_service_role: bool = False) -> Client:
    key = config.supabase_anon_key
    if use_service_role and config.supabase_service_role_key:
        key = config.supabase_service_role_key
    return create_client(config.supabase_url, key)


def get_crawl_state(
    client: Client,
    source_url: str,
    crawl_scope: str,
    sort_mode: str,
) -> Dict:
    result = (
        client.table("crawl_state")
        .select("source_url,crawl_scope,sort_mode,last_crawled_at,last_cursor,last_run_status,updated_at")
        .eq("source_url", source_url)
        .eq("crawl_scope", crawl_scope)
        .eq("sort_mode", sort_mode)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        return {
            "source_url": source_url,
            "crawl_scope": crawl_scope,
            "sort_mode": sort_mode,
            "last_crawled_at": None,
            "last_cursor": None,
            "last_run_status": None,
        }
    row = rows[0]
    if row.get("last_crawled_at"):
        try:
            row["last_crawled_at"] = dt_parser.isoparse(row["last_crawled_at"])
        except Exception:
            row["last_crawled_at"] = None
    return row


def upsert_crawl_state(
    client: Client,
    *,
    source_url: str,
    crawl_scope: str,
    sort_mode: str,
    last_crawled_at: Optional[datetime],
    last_cursor: Optional[str] = None,
    last_run_status: Optional[str] = None,
) -> None:
    payload = {
        "source_url": source_url,
        "crawl_scope": crawl_scope,
        "sort_mode": sort_mode,
        "last_crawled_at": (last_crawled_at or datetime.now(timezone.utc)).isoformat(),
        "last_cursor": last_cursor,
        "last_run_status": last_run_status,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    client.table("crawl_state").upsert(payload, on_conflict="source_url,crawl_scope,sort_mode").execute()


def upsert_documents(client: Client, rows: List[Dict]) -> List[Dict]:
    if not rows:
        return []
    response = client.table("documents").upsert(rows, on_conflict="source_url,external_id").execute()
    return response.data or []


def fetch_documents_by_external_ids(
    client: Client,
    source_url: str,
    external_ids: Iterable[str],
) -> List[Dict]:
    ids = list(external_ids)
    if not ids:
        return []

    collected: List[Dict] = []
    chunk_size = 150
    for idx in range(0, len(ids), chunk_size):
        chunk = ids[idx : idx + chunk_size]
        res = (
            client.table("documents")
            .select(
                "id,source_url,crawl_scope,sort_mode,external_id,parent_external_id,content,pii_masked_content,"
                "author,comment_url,published_at,status,is_spam,source_type,metadata,content_hash,last_seen_at"
            )
            .eq("source_url", source_url)
            .in_("external_id", chunk)
            .execute()
        )
        collected.extend(res.data or [])
    return collected


def fetch_embedding_hash_map(client: Client, document_ids: Iterable[str]) -> Dict[str, str]:
    ids = list(document_ids)
    if not ids:
        return {}

    hash_map: Dict[str, str] = {}
    chunk_size = 200
    for idx in range(0, len(ids), chunk_size):
        chunk = ids[idx : idx + chunk_size]
        res = (
            client.table("comment_embeddings")
            .select("document_id,content_hash")
            .in_("document_id", chunk)
            .execute()
        )
        for row in (res.data or []):
            doc_id = row.get("document_id")
            content_hash = row.get("content_hash")
            if doc_id:
                hash_map[doc_id] = content_hash or ""
    return hash_map


def upsert_embeddings(client: Client, rows: List[Dict]) -> List[Dict]:
    if not rows:
        return []
    response = client.table("comment_embeddings").upsert(rows, on_conflict="document_id").execute()
    return response.data or []


def search_similar_documents(
    client: Client,
    *,
    source_url: str,
    crawl_scope: Optional[str],
    sort_mode: Optional[str],
    query_embedding: List[float],
    top_k: int = 20,
    exclude_deleted: bool = True,
    exclude_spam: bool = True,
) -> List[Dict]:
    response = client.rpc(
        "match_comment_embeddings",
        {
            "query_embedding": query_embedding,
            "match_source_url": source_url,
            "match_crawl_scope": crawl_scope,
            "match_sort_mode": sort_mode,
            "match_count": top_k,
            "filter_exclude_deleted": exclude_deleted,
            "filter_exclude_spam": exclude_spam,
        },
    ).execute()
    return response.data or []


def fetch_recent_documents(
    client: Client,
    *,
    source_url: str,
    crawl_scope: Optional[str],
    sort_mode: Optional[str],
    limit: int = 30,
    exclude_deleted: bool = True,
    exclude_spam: bool = True,
) -> List[Dict]:
    query = (
        client.table("documents")
        .select(
            "id,content,pii_masked_content,author,comment_url,published_at,status,is_spam,metadata,content_hash"
        )
        .eq("source_url", source_url)
    )
    if crawl_scope:
        query = query.eq("crawl_scope", crawl_scope)
    if sort_mode:
        query = query.eq("sort_mode", sort_mode)
    if exclude_deleted:
        query = query.eq("status", "active")
    if exclude_spam:
        query = query.eq("is_spam", False)

    response = (
        query.order("published_at", desc=True)
        .order("last_seen_at", desc=True)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return response.data or []

