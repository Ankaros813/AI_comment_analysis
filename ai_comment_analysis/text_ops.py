from __future__ import annotations

import re
from typing import Iterable, Set


EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(r"\b(?:\+?\d{1,3}[-.\s]?)?(?:\d{2,4}[-.\s]?){2,4}\d{2,4}\b")
URL_RE = re.compile(r"\bhttps?://[^\s)]+", re.IGNORECASE)
LONG_NUMBER_RE = re.compile(r"\b\d{8,}\b")

REPEATED_CHAR_RE = re.compile(r"(.)\1{7,}", re.UNICODE)
SPAM_URL_HEAVY_RE = re.compile(r"(https?://|www\.)", re.IGNORECASE)


DEFAULT_DELETED_MARKERS = {
    "[deleted]",
    "삭제된 댓글",
    "삭제됨",
    "deleted by user",
    "removed",
}


DEFAULT_SPAM_KEYWORDS = {
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
}


def normalize_whitespace(text: str) -> str:
    return " ".join((text or "").split())


def csv_to_set(raw: str) -> Set[str]:
    if not raw:
        return set()
    return {token.strip().lower() for token in raw.split(",") if token.strip()}


def mask_pii(text: str) -> str:
    if not text:
        return ""
    output = text
    output = EMAIL_RE.sub("[EMAIL]", output)
    output = PHONE_RE.sub("[PHONE]", output)
    output = URL_RE.sub("[URL]", output)
    output = LONG_NUMBER_RE.sub("[NUMBER]", output)
    return output


def detect_deleted(
    content: str,
    markers: Iterable[str] | None = None,
) -> bool:
    normalized = normalize_whitespace(content).lower()
    if not normalized:
        return False
    marker_set = set(DEFAULT_DELETED_MARKERS)
    if markers:
        marker_set.update({m.lower() for m in markers if m})
    return any(marker in normalized for marker in marker_set)


def is_probable_spam(
    content: str,
    author: str | None = None,
    extra_keywords: Iterable[str] | None = None,
) -> bool:
    text = normalize_whitespace(content).lower()
    if not text:
        return False

    # Short repetitive noise
    if REPEATED_CHAR_RE.search(text):
        return True

    # URL-heavy + marketing-like pattern
    url_count = len(SPAM_URL_HEAVY_RE.findall(text))
    if url_count >= 2:
        return True

    keyword_set = set(DEFAULT_SPAM_KEYWORDS)
    if extra_keywords:
        keyword_set.update({k.lower() for k in extra_keywords if k})
    keyword_hits = sum(1 for kw in keyword_set if kw and kw in text)
    if keyword_hits >= 2:
        return True

    # Suspicious author handles
    if author:
        author_low = author.lower()
        if "bot" in author_low or "marketing" in author_low:
            return True

    return False

