from __future__ import annotations

import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from .config import AppConfig, RuntimeOptions
from .crawler import crawl_comments_incremental
from .db import (
    fetch_documents_by_external_ids,
    fetch_embedding_hash_map,
    fetch_recent_documents,
    get_crawl_state,
    make_client,
    search_similar_documents,
    upsert_crawl_state,
    upsert_documents,
    upsert_embeddings,
)
from .embeddings import EmbeddingService
from .rag import call_openrouter_analysis
from .text_ops import csv_to_set, is_probable_spam, mask_pii


POSITIVE_HINTS = {
    "좋다",
    "최고",
    "만족",
    "추천",
    "행복",
    "감사",
    "빠르",
    "great",
    "good",
    "love",
}

NEGATIVE_HINTS = {
    "별로",
    "최악",
    "불만",
    "느리",
    "환불",
    "실망",
    "문제",
    "버그",
    "bad",
    "worst",
    "hate",
}

STOPWORDS = {
    "그리고",
    "하지만",
    "그냥",
    "진짜",
    "정말",
    "이번",
    "너무",
    "해서",
    "하면",
    "the",
    "this",
    "that",
    "with",
    "from",
}


def _label_sentiment(text: str) -> str:
    low = (text or "").lower()
    pos = sum(1 for word in POSITIVE_HINTS if word in low)
    neg = sum(1 for word in NEGATIVE_HINTS if word in low)
    if pos > neg:
        return "positive"
    if neg > pos:
        return "negative"
    return "neutral"


def _extract_top_keywords(texts: List[str], top_n: int = 12) -> List[Dict]:
    tokens: List[str] = []
    for text in texts:
        words = re.findall(r"[A-Za-z0-9가-힣_]{2,}", (text or "").lower())
        for word in words:
            if word in STOPWORDS:
                continue
            tokens.append(word)
    counts = Counter(tokens).most_common(top_n)
    return [{"keyword": key, "count": count} for key, count in counts]


def _to_document_rows(comments, runtime: RuntimeOptions) -> List[Dict]:
    now_iso = datetime.now(timezone.utc).isoformat()
    spam_keywords = csv_to_set(runtime.spam_keywords_csv)
    rows = []
    seen_hashes = set()
    for comment in comments:
        if comment.content_hash in seen_hashes:
            continue
        seen_hashes.add(comment.content_hash)
        masked = mask_pii(comment.content)
        spam = is_probable_spam(comment.content, author=comment.author, extra_keywords=spam_keywords)
        rows.append(
            {
                "source_url": comment.source_url,
                "crawl_scope": runtime.crawl_scope,
                "sort_mode": runtime.sort_mode,
                "external_id": comment.external_id,
                "parent_external_id": comment.parent_external_id,
                "content": comment.content,
                "pii_masked_content": masked,
                "author": comment.author,
                "comment_url": comment.comment_url,
                "published_at": comment.published_at.isoformat() if comment.published_at else None,
                "status": comment.status,
                "is_spam": spam,
                "source_type": comment.source_type,
                "metadata": comment.metadata,
                "content_hash": comment.content_hash,
                "last_seen_at": now_iso,
                "updated_at": now_iso,
            }
        )
    return rows


def run_incremental_ingestion(
    config: AppConfig,
    runtime: RuntimeOptions,
    use_service_role: bool,
) -> Dict:
    client = make_client(config, use_service_role=use_service_role)
    state = get_crawl_state(
        client=client,
        source_url=runtime.source_url,
        crawl_scope=runtime.crawl_scope,
        sort_mode=runtime.sort_mode,
    )
    since_dt = state.get("last_crawled_at")

    adjusted_since = since_dt
    if adjusted_since and runtime.lookback_hours > 0:
        adjusted_since = adjusted_since - timedelta(hours=int(runtime.lookback_hours))

    comments, report = crawl_comments_incremental(
        runtime=runtime,
        since_dt=adjusted_since,
        timeout_sec=config.request_timeout_sec,
    )

    doc_rows = _to_document_rows(comments, runtime)
    upsert_documents(client, doc_rows)

    external_ids = [row["external_id"] for row in doc_rows]
    stored_rows = fetch_documents_by_external_ids(client, runtime.source_url, external_ids)

    # Embed only changed documents and skip deleted/spam if excluded from model stage.
    embed_candidates = []
    for row in stored_rows:
        if runtime.exclude_deleted_from_model and row.get("status") == "deleted":
            continue
        if runtime.exclude_spam_from_model and bool(row.get("is_spam")):
            continue
        embed_candidates.append(row)

    embedding_hashes = fetch_embedding_hash_map(client, [row["id"] for row in embed_candidates])
    to_embed = []
    skipped_unchanged = 0
    for row in embed_candidates:
        if embedding_hashes.get(row["id"]) == row.get("content_hash"):
            skipped_unchanged += 1
            continue
        to_embed.append(row)

    embedder = EmbeddingService(
        provider=config.embedding_provider,
        api_key=config.openrouter_api_key,
        model=config.embedding_model,
        dim=config.embed_dim,
        timeout_sec=config.request_timeout_sec,
    )
    texts_for_embedding = [
        row.get("pii_masked_content") if runtime.pii_mask_before_model else row.get("content", "")
        for row in to_embed
    ]
    vectors = embedder.embed_texts(texts_for_embedding)
    embedding_rows = []
    for row, emb in zip(to_embed, vectors):
        embedding_rows.append(
            {
                "document_id": row["id"],
                "embedding": emb,
                "content_hash": row.get("content_hash"),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        )
    upsert_embeddings(client, embedding_rows)

    newest_dt: Optional[datetime] = None
    for comment in comments:
        if comment.published_at and (newest_dt is None or comment.published_at > newest_dt):
            newest_dt = comment.published_at

    upsert_crawl_state(
        client=client,
        source_url=runtime.source_url,
        crawl_scope=runtime.crawl_scope,
        sort_mode=runtime.sort_mode,
        last_crawled_at=newest_dt or datetime.now(timezone.utc),
        last_cursor=report.last_cursor,
        last_run_status="ok",
    )

    deleted_count = sum(1 for row in doc_rows if row["status"] == "deleted")
    spam_count = sum(1 for row in doc_rows if row["is_spam"])
    return {
        "since_dt": since_dt.isoformat() if since_dt else None,
        "adjusted_since_dt": adjusted_since.isoformat() if adjusted_since else None,
        "pages_scanned": report.pages_scanned,
        "comments_found": report.comments_found,
        "comments_kept": report.comments_kept,
        "stored_docs": len(stored_rows),
        "embedded_docs": len(to_embed),
        "embedding_skipped_unchanged": skipped_unchanged,
        "embedding_provider": config.embedding_provider,
        "embedding_model": config.embedding_model if config.embedding_provider == "openrouter" else f"local-hash-{config.embed_dim}",
        "deleted_detected": deleted_count,
        "spam_detected": spam_count,
        "crawl_mode": report.crawl_mode,
        "crawl_notes": report.notes,
    }


def retrieve_context_documents(
    config: AppConfig,
    runtime: RuntimeOptions,
    query: str,
    use_service_role: bool,
) -> List[Dict]:
    client = make_client(config, use_service_role=use_service_role)
    embedder = EmbeddingService(
        provider=config.embedding_provider,
        api_key=config.openrouter_api_key,
        model=config.embedding_model,
        dim=config.embed_dim,
        timeout_sec=config.request_timeout_sec,
    )
    query_embedding = embedder.embed_texts([mask_pii(query) if runtime.pii_mask_before_model else query])[0]

    try:
        docs = search_similar_documents(
            client=client,
            source_url=runtime.source_url,
            crawl_scope=runtime.crawl_scope,
            sort_mode=runtime.sort_mode,
            query_embedding=query_embedding,
            top_k=config.top_k,
            exclude_deleted=runtime.exclude_deleted_from_model,
            exclude_spam=runtime.exclude_spam_from_model,
        )
    except Exception:
        docs = []

    if not docs:
        docs = fetch_recent_documents(
            client=client,
            source_url=runtime.source_url,
            crawl_scope=runtime.crawl_scope,
            sort_mode=runtime.sort_mode,
            limit=config.top_k,
            exclude_deleted=runtime.exclude_deleted_from_model,
            exclude_spam=runtime.exclude_spam_from_model,
        )
    return docs


def run_analysis_pipeline(
    config: AppConfig,
    runtime: RuntimeOptions,
    *,
    use_service_role: bool = True,
    model_name: Optional[str] = None,
) -> Dict:
    ingestion = run_incremental_ingestion(
        config=config,
        runtime=runtime,
        use_service_role=use_service_role,
    )
    docs = retrieve_context_documents(
        config=config,
        runtime=runtime,
        query=runtime.user_query,
        use_service_role=use_service_role,
    )

    analysis_text = call_openrouter_analysis(
        config=config,
        source_url=runtime.source_url,
        user_query=runtime.user_query,
        docs=docs,
        model_name=model_name or config.llm_model,
        use_masked_content=runtime.pii_mask_before_model,
    )

    content_key = "pii_masked_content" if runtime.pii_mask_before_model else "content"
    texts = [doc.get(content_key) or doc.get("content", "") for doc in docs]
    sentiment_counts = Counter(_label_sentiment(text) for text in texts)
    keyword_rows = _extract_top_keywords(texts, top_n=12)

    return {
        "ingestion": ingestion,
        "analysis_markdown": analysis_text,
        "documents": docs,
        "sentiment_counts": {
            "positive": sentiment_counts.get("positive", 0),
            "neutral": sentiment_counts.get("neutral", 0),
            "negative": sentiment_counts.get("negative", 0),
        },
        "keywords": keyword_rows,
    }
