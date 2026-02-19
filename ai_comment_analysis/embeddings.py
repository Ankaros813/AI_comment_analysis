from __future__ import annotations

import hashlib
import re
from typing import List

import requests


def _normalize(text: str) -> str:
    return " ".join((text or "").split())


def _hash_embed_one(text: str, dim: int) -> List[float]:
    tokens = re.findall(r"[a-z0-9\uac00-\ud7a3]+", _normalize(text).lower())
    if not tokens:
        return [0.0] * dim

    vec = [0.0] * dim
    for token in tokens[:240]:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        idx = int.from_bytes(digest[:4], "little") % dim
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        vec[idx] += sign

    norm = sum(v * v for v in vec) ** 0.5
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec


class EmbeddingService:
    def __init__(
        self,
        *,
        provider: str = "local",
        api_key: str = "",
        model: str = "openai/text-embedding-3-small",
        dim: int = 1536,
        timeout_sec: int = 45,
        batch_size: int = 48,
    ):
        provider = (provider or "local").strip().lower()
        if provider not in {"local", "openrouter"}:
            provider = "local"

        self.provider = provider
        self.api_key = api_key
        self.model = model
        self.dim = max(1, int(dim))
        self.timeout_sec = timeout_sec
        self.batch_size = max(1, min(128, int(batch_size)))

        if self.provider == "openrouter" and not self.api_key:
            raise ValueError("OPENROUTER_HACKERTHON_API_KEY is required for paid embeddings.")

    def _embed_batch_openrouter(self, texts: List[str]) -> List[List[float]]:
        payload = {
            "model": self.model,
            "input": texts,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://localhost.ai-comment-analysis",
            "X-Title": "AI Comment Analysis Embedding",
        }
        res = requests.post(
            "https://openrouter.ai/api/v1/embeddings",
            json=payload,
            headers=headers,
            timeout=self.timeout_sec,
        )
        if res.status_code >= 400:
            raise RuntimeError(f"OpenRouter embeddings failed ({res.status_code}): {res.text[:280]}")

        payload_json = res.json() or {}
        rows = list(payload_json.get("data") or [])
        rows.sort(key=lambda row: int(row.get("index", 0)))
        if len(rows) != len(texts):
            raise RuntimeError(f"Embedding count mismatch: expected {len(texts)}, got {len(rows)}")

        vectors: List[List[float]] = []
        for row in rows:
            vector = [float(v) for v in (row.get("embedding") or [])]
            if not vector:
                raise RuntimeError("OpenRouter returned an empty embedding vector.")
            if self.dim and len(vector) != self.dim:
                raise RuntimeError(f"Embedding dimension mismatch: expected {self.dim}, got {len(vector)}")
            vectors.append(vector)
        return vectors

    def embed_texts(self, texts: List[str]) -> List[List[float]]:
        normalized = [_normalize(text) for text in texts]
        if not normalized:
            return []

        if self.provider == "local":
            return [_hash_embed_one(text, self.dim) for text in normalized]

        out: List[List[float]] = []
        for i in range(0, len(normalized), self.batch_size):
            out.extend(self._embed_batch_openrouter(normalized[i : i + self.batch_size]))
        return out
