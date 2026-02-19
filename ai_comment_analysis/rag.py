from __future__ import annotations

from typing import Dict, List

import requests

from .config import AppConfig
from .prompts import SYSTEM_PROMPT, USER_PROMPT_TEMPLATE


def build_context_block(docs: List[Dict], max_chars: int, use_masked_content: bool) -> str:
    lines = []
    used = 0
    content_key = "pii_masked_content" if use_masked_content else "content"
    for i, doc in enumerate(docs, start=1):
        content = (doc.get(content_key) or doc.get("content") or "").strip()
        author = doc.get("author") or "anonymous"
        published_at = doc.get("published_at") or "time_unknown"
        line = f"[{i}] ({published_at}) @{author}: {content}"
        if used + len(line) > max_chars:
            break
        lines.append(line)
        used += len(line)
    return "\n".join(lines) if lines else "Insufficient comment data for reliable context."


def call_openrouter_analysis(
    config: AppConfig,
    *,
    source_url: str,
    user_query: str,
    docs: List[Dict],
    model_name: str,
    use_masked_content: bool = True,
) -> str:
    context = build_context_block(docs, config.max_context_chars, use_masked_content=use_masked_content)
    user_prompt = USER_PROMPT_TEMPLATE.format(
        user_query=user_query,
        source_url=source_url,
        context=context,
    )

    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
        "max_tokens": 1200,
    }
    headers = {
        "Authorization": f"Bearer {config.openrouter_api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://localhost.ai-comment-analysis",
        "X-Title": "AI Comment Analysis",
    }

    response = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        json=payload,
        headers=headers,
        timeout=config.request_timeout_sec,
    )
    response.raise_for_status()
    data = response.json()
    return data["choices"][0]["message"]["content"]

