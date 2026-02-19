from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv


DEFAULT_LLM_MODEL = "openai/gpt-4o-mini-2024-07-18"
DEFAULT_CRAWL_MODE = "static"  # static | dynamic | api_json
DEFAULT_COMMENT_SELECTOR = ".comment, .reply, [data-comment-id], li[class*='comment']"
DEFAULT_AUTHOR_SELECTOR = ".author, .user, .nickname, [class*='writer']"
DEFAULT_DATETIME_SELECTOR = "time, .date, .time, [class*='date']"
DEFAULT_NEXT_PAGE_SELECTOR = "a[rel='next'], .next a, a.next"


@dataclass
class AppConfig:
    openrouter_api_key: str
    supabase_url: str
    supabase_anon_key: str
    supabase_service_role_key: Optional[str] = None
    llm_model: str = DEFAULT_LLM_MODEL
    embedding_provider: str = "local"
    embedding_model: str = "openai/text-embedding-3-small"
    embed_dim: int = 1536
    top_k: int = 24
    max_context_chars: int = 14000
    request_timeout_sec: int = 45


@dataclass
class RuntimeOptions:
    # Analysis scope
    source_url: str
    user_query: str = "Analyze the latest comments and provide actionable insights."
    crawl_scope: str = "default"
    sort_mode: str = "default"  # latest | popular | custom label

    # Incremental behavior
    lookback_hours: int = 24
    max_pages: int = 6
    request_delay_sec: float = 0.2

    # Crawl mode
    crawl_mode: str = DEFAULT_CRAWL_MODE

    # Generic html selectors
    comment_selector: str = DEFAULT_COMMENT_SELECTOR
    author_selector: str = DEFAULT_AUTHOR_SELECTOR
    datetime_selector: str = DEFAULT_DATETIME_SELECTOR
    parent_selector: str = ""
    next_page_selector: str = DEFAULT_NEXT_PAGE_SELECTOR
    comment_id_attr: str = "data-comment-id"
    parent_id_attr: str = "data-parent-id"

    # Deleted/deleted-like comments
    deleted_selector: str = ""
    deleted_markers_csv: str = "[deleted],삭제된 댓글,삭제됨,deleted by user,removed"

    # Pagination by url param
    page_param_name: str = ""
    page_start: int = 1

    # Dynamic action controls
    wait_for_selector: str = ""
    consent_button_selector: str = ""
    pre_click_selectors_csv: str = ""
    sort_button_selector: str = ""
    sort_click_times: int = 1
    load_more_selector: str = ""
    load_more_max_clicks: int = 8
    enable_infinite_scroll: bool = False
    max_scroll_steps: int = 8
    scroll_pause_sec: float = 1.0
    enable_shadow_dom: bool = False
    frame_selector: str = ""

    # Transport/auth (all crawl modes)
    extra_headers_json: str = "{}"
    cookie_string: str = ""
    auth_bearer_token: str = ""
    max_retries: int = 2
    retry_backoff_sec: float = 1.0
    default_timezone_offset_hours: int = 0

    # API crawl mode settings (api_json)
    api_endpoint: str = ""
    api_method: str = "GET"
    api_params_json: str = "{}"
    api_payload_json: str = "{}"
    api_comments_path: str = "data.comments"
    api_has_more_path: str = "data.has_more"
    api_next_cursor_path: str = "data.next_cursor"
    api_page_param: str = "page"
    api_cursor_param: str = "cursor"
    api_id_field: str = "id"
    api_content_field: str = "content"
    api_author_field: str = "author"
    api_datetime_field: str = "created_at"
    api_parent_id_field: str = "parent_id"
    api_deleted_field: str = "is_deleted"

    # Model-stage filtering/safety
    exclude_deleted_from_model: bool = True
    exclude_spam_from_model: bool = True
    pii_mask_before_model: bool = True
    spam_keywords_csv: str = "무료,수익,클릭,dm,텔레그램,바카라,bit.ly,investment,casino"
    min_comment_length: int = 2


def load_env_files() -> None:
    candidates = [
        Path.cwd() / ".env",
        Path.cwd().parent / ".env",
        Path.home() / "Desktop" / ".env",
    ]
    for path in candidates:
        if path.exists():
            load_dotenv(path, override=False)


def _read_env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.getenv(name, default)
    if value is None:
        return None
    return value.strip()


def get_app_config(
    *,
    use_service_role: bool = False,
    override_model: Optional[str] = None,
) -> AppConfig:
    load_env_files()

    openrouter_api_key = _read_env("OPENROUTER_HACKERTHON_API_KEY")
    supabase_url = _read_env("SUPABASE_HACKERTHON_URL")
    supabase_anon_key = _read_env("SUPABASE_HACKERTHON_KEY")
    service_role_key = _read_env("SUPABASE_HACKERTHON_SERVICE_ROLE_KEY")

    missing = []
    if not openrouter_api_key:
        missing.append("OPENROUTER_HACKERTHON_API_KEY")
    if not supabase_url:
        missing.append("SUPABASE_HACKERTHON_URL")
    if not supabase_anon_key:
        missing.append("SUPABASE_HACKERTHON_KEY")
    if use_service_role and not service_role_key:
        missing.append("SUPABASE_HACKERTHON_SERVICE_ROLE_KEY")
    if missing:
        raise ValueError("Missing required environment variables: " + ", ".join(missing))

    model = override_model or _read_env("COMMENT_ANALYSIS_MODEL", DEFAULT_LLM_MODEL)
    embedding_provider = (_read_env("COMMENT_EMBEDDING_PROVIDER", "local") or "local").lower()
    use_paid_embedding = (_read_env("COMMENT_USE_PAID_EMBEDDING", "0") or "0") in {"1", "true", "yes", "on"}
    if use_paid_embedding:
        embedding_provider = "openrouter"
    if embedding_provider not in {"local", "openrouter"}:
        embedding_provider = "local"

    embedding_model = _read_env("COMMENT_EMBEDDING_MODEL", "openai/text-embedding-3-small")
    embed_dim = int(_read_env("COMMENT_EMBEDDING_DIM", "1536"))
    top_k = int(_read_env("COMMENT_TOP_K", "24"))
    max_context_chars = int(_read_env("COMMENT_MAX_CONTEXT_CHARS", "14000"))
    request_timeout_sec = int(_read_env("COMMENT_REQUEST_TIMEOUT_SEC", "45"))

    return AppConfig(
        openrouter_api_key=openrouter_api_key or "",
        supabase_url=supabase_url or "",
        supabase_anon_key=supabase_anon_key or "",
        supabase_service_role_key=service_role_key,
        llm_model=model or DEFAULT_LLM_MODEL,
        embedding_provider=embedding_provider,
        embedding_model=embedding_model or "openai/text-embedding-3-small",
        embed_dim=embed_dim,
        top_k=top_k,
        max_context_chars=max_context_chars,
        request_timeout_sec=request_timeout_sec,
    )
