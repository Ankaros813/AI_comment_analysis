from __future__ import annotations

import hashlib
import json
import re
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from dateutil import parser as dt_parser

from .config import RuntimeOptions
from .text_ops import csv_to_set, detect_deleted, normalize_whitespace


@dataclass
class CrawledComment:
    source_url: str
    external_id: str
    content: str
    author: Optional[str]
    comment_url: str
    published_at: Optional[datetime]
    parent_external_id: Optional[str]
    status: str
    metadata: Dict
    content_hash: str
    source_type: str


@dataclass
class CrawlReport:
    pages_scanned: int
    comments_found: int
    comments_kept: int
    started_at: datetime
    ended_at: datetime
    crawl_mode: str = "static"
    notes: str = ""
    last_cursor: Optional[str] = None


def _json_loads_obj(raw: str, default):
    if not raw:
        return default
    try:
        loaded = json.loads(raw)
        if isinstance(loaded, type(default)):
            return loaded
    except Exception:
        pass
    return default


def _cookie_dict(cookie_string: str) -> Dict[str, str]:
    cookies: Dict[str, str] = {}
    if not cookie_string:
        return cookies
    for part in cookie_string.split(";"):
        token = part.strip()
        if not token or "=" not in token:
            continue
        key, value = token.split("=", 1)
        cookies[key.strip()] = value.strip()
    return cookies


def _build_headers(runtime: RuntimeOptions) -> Dict[str, str]:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        ),
    }
    extra = _json_loads_obj(runtime.extra_headers_json, {})
    for key, value in extra.items():
        if value is not None:
            headers[str(key)] = str(value)
    if runtime.auth_bearer_token:
        headers["Authorization"] = f"Bearer {runtime.auth_bearer_token}"
    return headers


def _build_session(runtime: RuntimeOptions) -> requests.Session:
    session = requests.Session()
    session.headers.update(_build_headers(runtime))
    for key, value in _cookie_dict(runtime.cookie_string).items():
        session.cookies.set(key, value)
    return session


def _request_with_retry(
    session: requests.Session,
    *,
    method: str,
    url: str,
    timeout_sec: int,
    runtime: RuntimeOptions,
    params: Optional[Dict] = None,
    payload_json: Optional[Dict] = None,
) -> Optional[requests.Response]:
    attempts = max(0, int(runtime.max_retries)) + 1
    method_up = (method or "GET").upper()
    for attempt in range(attempts):
        try:
            response = session.request(
                method_up,
                url,
                timeout=timeout_sec,
                params=params,
                json=payload_json,
            )
            if response.status_code >= 500:
                raise requests.HTTPError(f"Server error: {response.status_code}")
            return response
        except Exception:
            if attempt + 1 >= attempts:
                return None
            backoff = float(runtime.retry_backoff_sec) * (2**attempt)
            time.sleep(max(0.1, backoff))
    return None


def _is_same_domain(base_url: str, candidate_url: str) -> bool:
    return urlparse(base_url).netloc == urlparse(candidate_url).netloc


def _set_page_query_param(base_url: str, param: str, value: int) -> str:
    parsed = urlparse(base_url)
    query_items = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query_items[param] = str(value)
    return urlunparse(parsed._replace(query=urlencode(query_items)))


def _parse_relative_time(raw: str, tz_offset_hours: int) -> Optional[datetime]:
    if not raw:
        return None
    text = raw.strip().lower()
    if not text:
        return None

    now_local = datetime.now(timezone(timedelta(hours=tz_offset_hours)))
    if text in {"just now", "방금"}:
        return now_local.astimezone(timezone.utc)
    if text in {"yesterday", "어제"}:
        return (now_local - timedelta(days=1)).astimezone(timezone.utc)

    relative_patterns = [
        (r"(\d+)\s*(초)\s*전", "seconds"),
        (r"(\d+)\s*(분)\s*전", "minutes"),
        (r"(\d+)\s*(시간)\s*전", "hours"),
        (r"(\d+)\s*(일)\s*전", "days"),
        (r"(\d+)\s*(주)\s*전", "weeks"),
        (r"(\d+)\s*(달|개월)\s*전", "months"),
        (r"(\d+)\s*(년)\s*전", "years"),
        (r"(\d+)\s*(sec|second|seconds)\s*ago", "seconds"),
        (r"(\d+)\s*(min|minute|minutes)\s*ago", "minutes"),
        (r"(\d+)\s*(hour|hours)\s*ago", "hours"),
        (r"(\d+)\s*(day|days)\s*ago", "days"),
        (r"(\d+)\s*(week|weeks)\s*ago", "weeks"),
        (r"(\d+)\s*(month|months)\s*ago", "months"),
        (r"(\d+)\s*(year|years)\s*ago", "years"),
    ]
    for pattern, unit in relative_patterns:
        match = re.search(pattern, text)
        if not match:
            continue
        value = int(match.group(1))
        if unit == "seconds":
            delta = timedelta(seconds=value)
        elif unit == "minutes":
            delta = timedelta(minutes=value)
        elif unit == "hours":
            delta = timedelta(hours=value)
        elif unit == "days":
            delta = timedelta(days=value)
        elif unit == "weeks":
            delta = timedelta(weeks=value)
        elif unit == "months":
            delta = timedelta(days=value * 30)
        else:
            delta = timedelta(days=value * 365)
        return (now_local - delta).astimezone(timezone.utc)
    return None


def _parse_datetime(raw: Optional[str], tz_offset_hours: int) -> Optional[datetime]:
    if not raw:
        return None
    text = raw.strip()
    if not text:
        return None
    try:
        parsed = dt_parser.parse(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone(timedelta(hours=tz_offset_hours)))
        return parsed.astimezone(timezone.utc)
    except Exception:
        return _parse_relative_time(text, tz_offset_hours)


def _pick_author(node, author_selector: str) -> Optional[str]:
    if not author_selector:
        return None
    for candidate in node.select(author_selector):
        text = normalize_whitespace(candidate.get_text(" ", strip=True))
        if text:
            return text[:120]
    return None


def _pick_datetime(node, datetime_selector: str, tz_offset_hours: int) -> Optional[datetime]:
    if not datetime_selector:
        return None
    for candidate in node.select(datetime_selector):
        raw = candidate.get("datetime") or candidate.get_text(" ", strip=True)
        parsed = _parse_datetime(raw, tz_offset_hours)
        if parsed:
            return parsed
    return None


def _make_external_id(
    *,
    page_url: str,
    idx: int,
    content: str,
    author: Optional[str],
    published_at: Optional[datetime],
) -> str:
    seed = f"{page_url}|{idx}|{author or ''}|{published_at.isoformat() if published_at else ''}|{content}"
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()


def _make_content_hash(
    *,
    source_url: str,
    external_id: str,
    content: str,
    author: Optional[str],
    published_at: Optional[datetime],
) -> str:
    seed = f"{source_url}|{external_id}|{author or ''}|{published_at.isoformat() if published_at else ''}|{content}"
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()


def _deleted_markers(runtime: RuntimeOptions) -> Set[str]:
    custom = csv_to_set(runtime.deleted_markers_csv)
    return custom if custom else set()


def _extract_comments_from_soup(
    *,
    soup: BeautifulSoup,
    page_url: str,
    runtime: RuntimeOptions,
    since_dt: Optional[datetime],
    seen_external_ids: Set[str],
    source_type: str,
) -> Tuple[List[CrawledComment], int]:
    nodes = soup.select(runtime.comment_selector)
    comments_found = len(nodes)
    comments: List[CrawledComment] = []
    markers = _deleted_markers(runtime)

    for idx, node in enumerate(nodes):
        content = normalize_whitespace(node.get_text(" ", strip=True))
        author = _pick_author(node, runtime.author_selector)
        published_at = _pick_datetime(node, runtime.datetime_selector, runtime.default_timezone_offset_hours)

        is_deleted = False
        if runtime.deleted_selector and node.select_one(runtime.deleted_selector):
            is_deleted = True
        if detect_deleted(content, markers):
            is_deleted = True

        if not is_deleted and len(content) < int(runtime.min_comment_length):
            continue
        if since_dt and published_at and published_at <= since_dt:
            continue

        external_id = node.get(runtime.comment_id_attr) if runtime.comment_id_attr else None
        if not external_id:
            external_id = _make_external_id(
                page_url=page_url,
                idx=idx,
                content=content,
                author=author,
                published_at=published_at,
            )
        external_id = str(external_id)
        if external_id in seen_external_ids:
            continue
        seen_external_ids.add(external_id)

        parent_external_id = None
        if runtime.parent_id_attr:
            parent_external_id = node.get(runtime.parent_id_attr)
        if not parent_external_id and runtime.parent_selector:
            parent_node = node.select_one(runtime.parent_selector)
            if parent_node is not None and runtime.comment_id_attr:
                parent_external_id = parent_node.get(runtime.comment_id_attr)

        content_hash = _make_content_hash(
            source_url=runtime.source_url,
            external_id=external_id,
            content=content,
            author=author,
            published_at=published_at,
        )
        comments.append(
            CrawledComment(
                source_url=runtime.source_url,
                external_id=external_id,
                content=content,
                author=author,
                comment_url=page_url,
                published_at=published_at,
                parent_external_id=parent_external_id,
                status="deleted" if is_deleted else "active",
                metadata={
                    "page_title": normalize_whitespace(soup.title.string if soup.title else ""),
                    "collected_at": datetime.now(timezone.utc).isoformat(),
                    "sort_mode": runtime.sort_mode,
                },
                content_hash=content_hash,
                source_type=source_type,
            )
        )
    return comments, comments_found


def _json_get(data, path: str):
    if path is None or path == "":
        return data
    current = data
    for token in path.split("."):
        token = token.strip()
        if not token:
            continue
        if isinstance(current, list):
            try:
                idx = int(token)
            except Exception:
                return None
            if idx < 0 or idx >= len(current):
                return None
            current = current[idx]
            continue
        if not isinstance(current, dict):
            return None
        if token not in current:
            return None
        current = current[token]
    return current


def _extract_comments_from_json(
    *,
    payload: Dict,
    runtime: RuntimeOptions,
    source_url: str,
    since_dt: Optional[datetime],
    seen_external_ids: Set[str],
    page_num: int,
    cursor: Optional[str],
) -> Tuple[List[CrawledComment], int]:
    rows = _json_get(payload, runtime.api_comments_path)
    if not isinstance(rows, list):
        rows = []
    comments_found = len(rows)
    comments: List[CrawledComment] = []
    markers = _deleted_markers(runtime)

    for idx, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        content = normalize_whitespace(str(_json_get(row, runtime.api_content_field) or ""))
        author_value = _json_get(row, runtime.api_author_field)
        author = normalize_whitespace(str(author_value)) if author_value is not None else None
        dt_raw = _json_get(row, runtime.api_datetime_field)
        published_at = _parse_datetime(str(dt_raw), runtime.default_timezone_offset_hours) if dt_raw else None

        deleted_raw = _json_get(row, runtime.api_deleted_field)
        deleted_flag = bool(deleted_raw) if deleted_raw is not None else False
        is_deleted = deleted_flag or detect_deleted(content, markers)

        if not is_deleted and len(content) < int(runtime.min_comment_length):
            continue
        if since_dt and published_at and published_at <= since_dt:
            continue

        external_id = _json_get(row, runtime.api_id_field)
        if not external_id:
            external_id = _make_external_id(
                page_url=source_url,
                idx=idx,
                content=content,
                author=author,
                published_at=published_at,
            )
        external_id = str(external_id)
        if external_id in seen_external_ids:
            continue
        seen_external_ids.add(external_id)

        parent_external_id = _json_get(row, runtime.api_parent_id_field)
        content_hash = _make_content_hash(
            source_url=runtime.source_url,
            external_id=external_id,
            content=content,
            author=author,
            published_at=published_at,
        )
        comments.append(
            CrawledComment(
                source_url=runtime.source_url,
                external_id=external_id,
                content=content,
                author=author,
                comment_url=source_url,
                published_at=published_at,
                parent_external_id=str(parent_external_id) if parent_external_id else None,
                status="deleted" if is_deleted else "active",
                metadata={
                    "collected_at": datetime.now(timezone.utc).isoformat(),
                    "sort_mode": runtime.sort_mode,
                    "page_num": page_num,
                    "cursor": cursor,
                },
                content_hash=content_hash,
                source_type="api_json",
            )
        )
    return comments, comments_found


def _crawl_static_comments_incremental(
    runtime: RuntimeOptions,
    since_dt: Optional[datetime],
    timeout_sec: int,
) -> Tuple[List[CrawledComment], CrawlReport]:
    started_at = datetime.now(timezone.utc)
    session = _build_session(runtime)

    if runtime.page_param_name:
        queue = deque(
            [
                _set_page_query_param(runtime.source_url, runtime.page_param_name, runtime.page_start + i)
                for i in range(runtime.max_pages)
            ]
        )
    else:
        queue = deque([runtime.source_url])

    visited: Set[str] = set()
    seen_external_ids: Set[str] = set()
    comments: List[CrawledComment] = []
    pages_scanned = 0
    comments_found = 0

    while queue and pages_scanned < runtime.max_pages:
        page_url = queue.popleft()
        if page_url in visited:
            continue
        visited.add(page_url)
        pages_scanned += 1

        response = _request_with_retry(
            session,
            method="GET",
            url=page_url,
            timeout_sec=timeout_sec,
            runtime=runtime,
        )
        if response is None or response.status_code >= 400:
            continue

        soup = BeautifulSoup(response.text, "html.parser")
        extracted, found = _extract_comments_from_soup(
            soup=soup,
            page_url=page_url,
            runtime=runtime,
            since_dt=since_dt,
            seen_external_ids=seen_external_ids,
            source_type="static_html",
        )
        comments_found += found
        comments.extend(extracted)

        if not runtime.page_param_name:
            next_links = soup.select(runtime.next_page_selector)
            for anchor in next_links:
                href = anchor.get("href")
                if not href:
                    continue
                next_url = urljoin(page_url, href)
                if _is_same_domain(runtime.source_url, next_url) and next_url not in visited:
                    queue.append(next_url)

        if runtime.request_delay_sec > 0:
            time.sleep(runtime.request_delay_sec)

    ended_at = datetime.now(timezone.utc)
    return comments, CrawlReport(
        pages_scanned=pages_scanned,
        comments_found=comments_found,
        comments_kept=len(comments),
        started_at=started_at,
        ended_at=ended_at,
        crawl_mode="static",
    )


def _safe_click(page, selector: str) -> bool:
    if not selector:
        return False
    try:
        locator = page.locator(selector)
        if locator.count() == 0:
            return False
        locator.first.click(timeout=3000)
        return True
    except Exception:
        return False


def _run_infinite_scroll(page, runtime: RuntimeOptions) -> None:
    if not runtime.enable_infinite_scroll:
        return
    wait_ms = int(max(0.1, runtime.scroll_pause_sec) * 1000)
    stagnant_steps = 0
    for _ in range(max(1, runtime.max_scroll_steps)):
        try:
            prev_height = int(page.evaluate("document.body.scrollHeight") or 0)
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(wait_ms)
            new_height = int(page.evaluate("document.body.scrollHeight") or 0)
            if new_height <= prev_height:
                stagnant_steps += 1
            else:
                stagnant_steps = 0
            if stagnant_steps >= 2:
                break
        except Exception:
            break


def _click_csv_selectors(page, selectors_csv: str, wait_ms: int) -> None:
    if not selectors_csv:
        return
    selectors = [s.strip() for s in selectors_csv.split(",") if s.strip()]
    for selector in selectors:
        if _safe_click(page, selector):
            page.wait_for_timeout(wait_ms)


def _run_dynamic_actions(page, runtime: RuntimeOptions) -> None:
    wait_ms = int(max(0.1, runtime.scroll_pause_sec) * 1000)
    if runtime.wait_for_selector:
        try:
            page.wait_for_selector(runtime.wait_for_selector, timeout=5000)
        except Exception:
            pass

    if runtime.consent_button_selector:
        _safe_click(page, runtime.consent_button_selector)
        page.wait_for_timeout(wait_ms)

    _click_csv_selectors(page, runtime.pre_click_selectors_csv, wait_ms)

    if runtime.sort_button_selector:
        for _ in range(max(1, runtime.sort_click_times)):
            if not _safe_click(page, runtime.sort_button_selector):
                break
            page.wait_for_timeout(wait_ms)

    _run_infinite_scroll(page, runtime)

    if runtime.load_more_selector:
        for _ in range(max(0, runtime.load_more_max_clicks)):
            if not _safe_click(page, runtime.load_more_selector):
                break
            page.wait_for_timeout(wait_ms)
            if runtime.enable_infinite_scroll:
                _run_infinite_scroll(page, runtime)


def _collect_shadow_comments(frame, runtime: RuntimeOptions) -> List[Dict]:
    if not runtime.enable_shadow_dom:
        return []
    script = """
    (params) => {
      const out = [];
      const seenRoots = new WeakSet();
      const textOf = (el) => (el ? ((el.innerText || el.textContent || '').trim()) : '');
      const walk = (root) => {
        if (!root || seenRoots.has(root)) return;
        seenRoots.add(root);
        let comments = [];
        try { comments = root.querySelectorAll(params.commentSelector); } catch (e) {}
        comments.forEach((el, idx) => {
          let authorEl = null;
          let timeEl = null;
          try { if (params.authorSelector) authorEl = el.querySelector(params.authorSelector); } catch (e) {}
          try { if (params.datetimeSelector) timeEl = el.querySelector(params.datetimeSelector); } catch (e) {}
          out.push({
            content: textOf(el),
            author: textOf(authorEl),
            datetime: timeEl ? (timeEl.getAttribute('datetime') || textOf(timeEl)) : '',
            external_id: params.commentIdAttr ? (el.getAttribute(params.commentIdAttr) || '') : '',
            parent_external_id: params.parentIdAttr ? (el.getAttribute(params.parentIdAttr) || '') : ''
          });
        });
        let all = [];
        try { all = root.querySelectorAll('*'); } catch (e) {}
        all.forEach((el) => {
          if (el.shadowRoot) walk(el.shadowRoot);
        });
      };
      walk(document);
      return out;
    }
    """
    try:
        result = frame.evaluate(
            script,
            {
                "commentSelector": runtime.comment_selector,
                "authorSelector": runtime.author_selector,
                "datetimeSelector": runtime.datetime_selector,
                "commentIdAttr": runtime.comment_id_attr,
                "parentIdAttr": runtime.parent_id_attr,
            },
        )
        if isinstance(result, list):
            return result
    except Exception:
        pass
    return []


def _shadow_entries_to_comments(
    *,
    entries: Iterable[Dict],
    page_url: str,
    runtime: RuntimeOptions,
    since_dt: Optional[datetime],
    seen_external_ids: Set[str],
) -> List[CrawledComment]:
    comments: List[CrawledComment] = []
    markers = _deleted_markers(runtime)
    for idx, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        content = normalize_whitespace(str(entry.get("content") or ""))
        author = normalize_whitespace(str(entry.get("author") or "")) or None
        published_at = _parse_datetime(
            str(entry.get("datetime") or ""),
            runtime.default_timezone_offset_hours,
        )
        is_deleted = detect_deleted(content, markers)
        if not is_deleted and len(content) < int(runtime.min_comment_length):
            continue
        if since_dt and published_at and published_at <= since_dt:
            continue

        external_id = str(entry.get("external_id") or "").strip()
        if not external_id:
            external_id = _make_external_id(
                page_url=page_url,
                idx=idx,
                content=content,
                author=author,
                published_at=published_at,
            )
        if external_id in seen_external_ids:
            continue
        seen_external_ids.add(external_id)

        parent_external_id = str(entry.get("parent_external_id") or "").strip() or None
        content_hash = _make_content_hash(
            source_url=runtime.source_url,
            external_id=external_id,
            content=content,
            author=author,
            published_at=published_at,
        )
        comments.append(
            CrawledComment(
                source_url=runtime.source_url,
                external_id=external_id,
                content=content,
                author=author,
                comment_url=page_url,
                published_at=published_at,
                parent_external_id=parent_external_id,
                status="deleted" if is_deleted else "active",
                metadata={
                    "collected_at": datetime.now(timezone.utc).isoformat(),
                    "sort_mode": runtime.sort_mode,
                    "shadow_dom": True,
                },
                content_hash=content_hash,
                source_type="dynamic_shadow",
            )
        )
    return comments


def _frame_targets(page, runtime: RuntimeOptions):
    if runtime.frame_selector:
        try:
            frame_el = page.locator(runtime.frame_selector).first
            frame = frame_el.content_frame()
            if frame:
                return [frame]
        except Exception:
            return [page.main_frame]
    targets = [page.main_frame]
    for frame in page.frames:
        if frame == page.main_frame:
            continue
        if frame.url and frame.url != "about:blank":
            targets.append(frame)
    return targets


def _goto(page, target_url: str, timeout_sec: int, runtime: RuntimeOptions) -> bool:
    attempts = max(0, int(runtime.max_retries)) + 1
    for attempt in range(attempts):
        try:
            page.goto(target_url, wait_until="domcontentloaded", timeout=max(5, timeout_sec) * 1000)
            return True
        except Exception:
            if attempt + 1 >= attempts:
                return False
            wait_ms = int(max(0.1, runtime.retry_backoff_sec) * (2**attempt) * 1000)
            page.wait_for_timeout(wait_ms)
    return False


def _crawl_dynamic_comments_incremental(
    runtime: RuntimeOptions,
    since_dt: Optional[datetime],
    timeout_sec: int,
) -> Tuple[List[CrawledComment], CrawlReport]:
    started_at = datetime.now(timezone.utc)
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        raise RuntimeError(
            "dynamic mode requires playwright. Run: pip install playwright && playwright install chromium"
        ) from exc

    seen_external_ids: Set[str] = set()
    comments: List[CrawledComment] = []
    pages_scanned = 0
    comments_found = 0
    notes: List[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(user_agent=_build_headers(runtime)["User-Agent"])
        context.set_extra_http_headers(_build_headers(runtime))
        page = context.new_page()

        if runtime.page_param_name:
            target_urls = [
                _set_page_query_param(runtime.source_url, runtime.page_param_name, runtime.page_start + i)
                for i in range(runtime.max_pages)
            ]
        else:
            target_urls = [runtime.source_url]

        visited: Set[str] = set()
        idx = 0
        while idx < len(target_urls) and pages_scanned < runtime.max_pages:
            current_url = target_urls[idx]
            idx += 1
            if current_url in visited:
                continue
            visited.add(current_url)

            if not _goto(page, current_url, timeout_sec, runtime):
                notes.append(f"goto failed: {current_url}")
                continue
            pages_scanned += 1

            _run_dynamic_actions(page, runtime)
            frame_list = _frame_targets(page, runtime)
            frame_comments_found = 0
            for frame in frame_list:
                try:
                    soup = BeautifulSoup(frame.content(), "html.parser")
                    extracted, found = _extract_comments_from_soup(
                        soup=soup,
                        page_url=frame.url or page.url,
                        runtime=runtime,
                        since_dt=since_dt,
                        seen_external_ids=seen_external_ids,
                        source_type="dynamic_html",
                    )
                    frame_comments_found += found
                    comments.extend(extracted)

                    shadow_entries = _collect_shadow_comments(frame, runtime)
                    comments.extend(
                        _shadow_entries_to_comments(
                            entries=shadow_entries,
                            page_url=frame.url or page.url,
                            runtime=runtime,
                            since_dt=since_dt,
                            seen_external_ids=seen_external_ids,
                        )
                    )
                except Exception:
                    continue
            comments_found += frame_comments_found

            if runtime.page_param_name:
                continue
            if pages_scanned >= runtime.max_pages:
                break

            if runtime.next_page_selector:
                try:
                    locator = page.locator(runtime.next_page_selector)
                    if locator.count() > 0:
                        href = locator.first.get_attribute("href")
                        if href:
                            next_url = urljoin(page.url, href)
                            if _is_same_domain(runtime.source_url, next_url) and next_url not in visited:
                                target_urls.append(next_url)
                                continue
                        if _safe_click(page, runtime.next_page_selector):
                            page.wait_for_timeout(int(max(0.1, runtime.scroll_pause_sec) * 1000))
                            if page.url not in visited:
                                target_urls.append(page.url)
                except Exception:
                    pass

        context.close()
        browser.close()

    ended_at = datetime.now(timezone.utc)
    return comments, CrawlReport(
        pages_scanned=pages_scanned,
        comments_found=comments_found,
        comments_kept=len(comments),
        started_at=started_at,
        ended_at=ended_at,
        crawl_mode="dynamic",
        notes="; ".join(notes)[:500],
    )


def _crawl_api_comments_incremental(
    runtime: RuntimeOptions,
    since_dt: Optional[datetime],
    timeout_sec: int,
) -> Tuple[List[CrawledComment], CrawlReport]:
    started_at = datetime.now(timezone.utc)
    session = _build_session(runtime)
    endpoint = runtime.api_endpoint.strip() or runtime.source_url
    method = (runtime.api_method or "GET").upper()

    base_params = _json_loads_obj(runtime.api_params_json, {})
    base_payload = _json_loads_obj(runtime.api_payload_json, {})

    pages_scanned = 0
    comments_found = 0
    comments: List[CrawledComment] = []
    seen_external_ids: Set[str] = set()
    cursor: Optional[str] = None
    has_more = True

    while has_more and pages_scanned < runtime.max_pages:
        page_num = runtime.page_start + pages_scanned
        params = dict(base_params)
        payload = dict(base_payload)

        if runtime.api_page_param:
            if method == "GET":
                params[runtime.api_page_param] = page_num
            else:
                payload[runtime.api_page_param] = page_num
        if runtime.api_cursor_param and cursor:
            if method == "GET":
                params[runtime.api_cursor_param] = cursor
            else:
                payload[runtime.api_cursor_param] = cursor

        response = _request_with_retry(
            session,
            method=method,
            url=endpoint,
            timeout_sec=timeout_sec,
            runtime=runtime,
            params=params if method == "GET" else None,
            payload_json=payload if method != "GET" else None,
        )
        pages_scanned += 1
        if response is None or response.status_code >= 400:
            break

        try:
            payload_json = response.json()
        except Exception:
            break

        extracted, found = _extract_comments_from_json(
            payload=payload_json,
            runtime=runtime,
            source_url=endpoint,
            since_dt=since_dt,
            seen_external_ids=seen_external_ids,
            page_num=page_num,
            cursor=cursor,
        )
        comments_found += found
        comments.extend(extracted)

        next_cursor = _json_get(payload_json, runtime.api_next_cursor_path)
        has_more_raw = _json_get(payload_json, runtime.api_has_more_path)
        if isinstance(has_more_raw, bool):
            has_more = has_more_raw
        else:
            has_more = bool(next_cursor) or (found > 0)
        cursor = str(next_cursor) if next_cursor is not None else None

        if runtime.request_delay_sec > 0:
            time.sleep(runtime.request_delay_sec)

    ended_at = datetime.now(timezone.utc)
    return comments, CrawlReport(
        pages_scanned=pages_scanned,
        comments_found=comments_found,
        comments_kept=len(comments),
        started_at=started_at,
        ended_at=ended_at,
        crawl_mode="api_json",
        last_cursor=cursor,
    )


def crawl_comments_incremental(
    runtime: RuntimeOptions,
    since_dt: Optional[datetime],
    timeout_sec: int = 20,
) -> Tuple[List[CrawledComment], CrawlReport]:
    mode = (runtime.crawl_mode or "static").strip().lower()
    if mode == "api_json":
        return _crawl_api_comments_incremental(runtime, since_dt, timeout_sec)
    if mode == "dynamic":
        try:
            return _crawl_dynamic_comments_incremental(runtime, since_dt, timeout_sec)
        except Exception as exc:
            comments, report = _crawl_static_comments_incremental(runtime, since_dt, timeout_sec)
            report.notes = f"dynamic failed and fell back to static: {type(exc).__name__}"
            return comments, report
    return _crawl_static_comments_incremental(runtime, since_dt, timeout_sec)
