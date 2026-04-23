"""LLM-based cross-encoder reranker for memory search.

Hybrid retrieval (vector + keyword + entity RRF) is a recall-maximizing first
stage — it pulls in the right candidates but its ordering is noisy. An LLM
reranker scores query↔candidate pairs together, which is what Mem0 does with
Cohere rerank-v3. We use gpt-4o-mini for cost/latency; one call per search
(~$0.001), adds ~400-800ms.

Design:
  - Input: query text, candidate list from repo.search
  - Model is asked to score each candidate 0..10 for relevance
  - Output: candidates reordered by rerank_score with score added to each row
  - On any failure: return input unchanged (reranker is additive, not critical)
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from typing import Optional

from openai import OpenAI

from app.config import get_settings

logger = logging.getLogger(__name__)


_RERANK_SYSTEM_PROMPT = """You score the relevance of candidate memories to a user's search query.

For each candidate, output a score from 0 to 10:
  10 = directly answers the query; user clearly wants this
   7 = strongly related; likely relevant
   4 = tangentially related
   1 = same domain but different topic
   0 = unrelated

Focus on SEMANTIC MATCH to the query's intent, not surface keyword overlap.
A preference about "Python 3.11" is highly relevant to a query about "user's Python version";
a random mention of Python in a different context is not.

Return JSON exactly as:
{"scores": [{"id": 1, "score": 8.5}, {"id": 2, "score": 3.0}, ...]}

Include every candidate id you were given. Use decimals when helpful.
"""


class RerankerService:
    """LLM-based cross-encoder for reordering retrieval candidates."""

    # gpt-4o-mini gives good relevance judgment without the reasoning-model
    # latency tax. Swap via settings.rerank_model if needed.
    _DEFAULT_MODEL = "gpt-4o-mini"
    # Reranker scores at most this many candidates in one LLM call. Must be
    # at least as large as MemoryService._RERANK_POOL_SIZE — otherwise the
    # caller hands us a pool we silently truncate before scoring, defeating
    # the point of over-fetching.
    _MAX_CANDIDATES = 60
    _MAX_CONTENT_CHARS = 400

    def __init__(self):
        settings = get_settings()
        self.client = OpenAI(api_key=settings.openai_api_key, max_retries=3)
        self.model = getattr(settings, "rerank_model", None) or self._DEFAULT_MODEL

    def rerank(
        self,
        query: str,
        candidates: list[dict],
        top_k: int = 10,
    ) -> list[dict]:
        """Rerank candidates by LLM-judged relevance to the query.

        Returns up to top_k candidates, sorted by `rerank_score` (float 0..10).
        On any failure, returns the original top_k unchanged so a reranker
        outage degrades retrieval gracefully rather than breaking it.
        """
        if not candidates or not query:
            return candidates[:top_k]
        # Trim to our max to bound the LLM prompt size.
        pool = candidates[: self._MAX_CANDIDATES]
        if len(pool) == 1:
            pool[0] = {**pool[0], "rerank_score": 10.0}
            return pool

        try:
            scores = self._score(query, pool)
        except Exception as e:
            logger.warning("Rerank failed, falling back to original order: %s", e)
            return candidates[:top_k]

        if not scores:
            return candidates[:top_k]

        # Merge scores back; candidates not scored get 0.
        for i, cand in enumerate(pool):
            cand["rerank_score"] = float(scores.get(i + 1, 0.0))

        pool.sort(key=lambda c: c.get("rerank_score", 0.0), reverse=True)
        return pool[:top_k]

    def _score(self, query: str, pool: list[dict]) -> dict[int, float]:
        """Single LLM call to score every candidate. Returns {1-indexed-id: score}."""
        numbered = []
        for i, c in enumerate(pool, start=1):
            content = (c.get("content") or "")[: self._MAX_CONTENT_CHARS]
            numbered.append(f"[{i}] {content}")
        user_msg = (
            f"QUERY: {query[:500]}\n\n"
            f"CANDIDATES (id in brackets):\n" + "\n".join(numbered)
        )
        resp = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": _RERANK_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            response_format={"type": "json_object"},
            temperature=0.0,
            # 60 candidates * ~25 chars per {"id":N,"score":X.X} ≈ 1500 chars
            # ≈ 400 tokens. 1200 leaves headroom so the JSON isn't truncated
            # mid-list, which silently drops scores for items at the tail
            # and leaves them at 0 (treated as irrelevant).
            max_tokens=1200,
        )
        raw = resp.choices[0].message.content or "{}"
        data = json.loads(raw)
        scores_list = data.get("scores") or []
        out: dict[int, float] = {}
        for item in scores_list:
            if not isinstance(item, dict):
                continue
            try:
                cid = int(item.get("id"))
                sc = float(item.get("score"))
            except (TypeError, ValueError):
                continue
            out[cid] = max(0.0, min(10.0, sc))
        return out


@lru_cache
def get_reranker_service() -> RerankerService:
    return RerankerService()
