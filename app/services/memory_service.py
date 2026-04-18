"""Memory service — personal memory layer.

Handles:
  - Explicit memory writes (user-conscious facts)
  - LLM-based extraction from conversation turns
  - Hybrid search scoped to the user
  - Profile aggregation (memories + top experiences)
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from openai import OpenAI

from app.config import get_settings
from app.repositories.experience_repo import ExperienceRepository
from app.repositories.memory_repo import MemoryRepository
from app.services.embedding_service import get_embedding_service

logger = logging.getLogger(__name__)


EXTRACTION_SYSTEM_PROMPT = """You extract DURABLE facts about a user from a conversation turn.

Return a JSON object: {"memories": [{"content": "...", "memory_type": "fact|preference|observation|note", "importance": "high|medium|low"}]}

Rules:
- Only extract things worth remembering long-term: preferences, stable facts, important context.
- Do NOT extract: transient task state, routine chit-chat, things already widely known.
- Each memory should be a single sentence, standalone (no pronouns referring to prior turns).
- Prefer fewer high-quality memories over many low-value ones.
- If the turn has nothing worth remembering, return {"memories": []}.

Types:
- fact: objective statement about the user ("User is a backend engineer")
- preference: stated preference ("User prefers Python 3.11")
- observation: inferred from behavior ("User often works with PostgreSQL")
- note: freeform, use sparingly

Importance:
- high: identity, explicit preferences, critical context
- medium: useful context
- low: minor details
"""


class MemoryService:
    def __init__(self):
        self.repo = MemoryRepository()
        self.experience_repo = ExperienceRepository()
        self.embedding = get_embedding_service()
        settings = get_settings()
        self._openai = OpenAI(api_key=settings.openai_api_key)
        self._extraction_model = "gpt-4o-mini"  # fast + cheap for fact extraction

    # -----------------------------------------------------------------------
    # Explicit create
    # -----------------------------------------------------------------------

    def create(
        self,
        user_id: UUID,
        data: dict,
        agent_id: Optional[UUID] = None,
        session_id: Optional[UUID] = None,
    ) -> dict:
        """Create a single memory with embedding."""
        content = data["content"]
        embedding = self.embedding.generate_embedding(content[:8000])

        row = {
            "user_id": str(user_id),
            "content": content,
            "memory_type": data.get("memory_type", "fact"),
            "importance": data.get("importance", "medium"),
            "metadata": data.get("metadata") or {},
            "embedding": embedding,
        }
        if agent_id:
            row["agent_id"] = str(agent_id)
        if session_id:
            row["session_id"] = str(session_id)
        if data.get("expires_at"):
            row["expires_at"] = data["expires_at"].isoformat() if isinstance(
                data["expires_at"], datetime
            ) else data["expires_at"]

        return self.repo.create(row)

    # -----------------------------------------------------------------------
    # LLM extraction from a turn pair
    # -----------------------------------------------------------------------

    def extract_from_turn(
        self,
        user_id: UUID,
        user_content: str,
        assistant_content: str,
        agent_id: Optional[UUID] = None,
        session_id: Optional[UUID] = None,
        metadata: Optional[dict] = None,
    ) -> list[dict]:
        """Run an LLM pass over a turn to extract durable memories.

        Returns the list of stored memory rows (may be empty).
        """
        user_msg = f"USER:\n{user_content}\n\nASSISTANT:\n{assistant_content}"
        try:
            resp = self._openai.chat.completions.create(
                model=self._extraction_model,
                messages=[
                    {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                    {"role": "user", "content": user_msg},
                ],
                response_format={"type": "json_object"},
                temperature=0.2,
                max_tokens=600,
            )
            raw = resp.choices[0].message.content or "{}"
            parsed = json.loads(raw)
            candidates = parsed.get("memories", [])
        except Exception as e:
            logger.warning("Memory extraction failed: %s", e)
            return []

        if not isinstance(candidates, list) or not candidates:
            return []

        # Generate embeddings in one batch for efficiency
        contents = [
            c.get("content", "").strip()
            for c in candidates
            if isinstance(c, dict) and c.get("content")
        ]
        if not contents:
            return []

        embeddings = self.embedding.generate_embeddings([c[:8000] for c in contents])

        rows = []
        for cand, content, emb in zip(candidates, contents, embeddings):
            row = {
                "user_id": str(user_id),
                "content": content,
                "memory_type": cand.get("memory_type", "fact") if isinstance(cand, dict) else "fact",
                "importance": cand.get("importance", "medium") if isinstance(cand, dict) else "medium",
                "metadata": metadata or {},
                "embedding": emb,
                "source_user": user_content[:2000],
                "source_assistant": assistant_content[:2000],
            }
            if agent_id:
                row["agent_id"] = str(agent_id)
            if session_id:
                row["session_id"] = str(session_id)
            rows.append(row)

        return self.repo.create_batch(rows)

    # -----------------------------------------------------------------------
    # Reads
    # -----------------------------------------------------------------------

    def get(self, identifier: str, user_id: UUID) -> dict:
        return self.repo.get_by_identifier(identifier, user_id)

    def list_memories(
        self,
        user_id: UUID,
        memory_type: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        items, total = self.repo.list_memories(
            user_id=user_id,
            memory_type=memory_type,
            limit=limit,
            offset=offset,
        )
        return {
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + limit < total,
        }

    def search(
        self,
        user_id: UUID,
        query: str,
        memory_type: Optional[str] = None,
        limit: int = 10,
    ) -> dict:
        """Hybrid search over the user's memories."""
        embedding = self.embedding.generate_embedding(query[:8000])
        results = self.repo.search(
            user_id=user_id,
            query_text=query,
            query_embedding=embedding,
            match_count=limit,
            memory_type=memory_type,
        )
        return {
            "query": query,
            "results": results,
            "total_found": len(results),
        }

    def delete(self, identifier: str, user_id: UUID, hard: bool = False) -> None:
        memory = self.repo.get_by_identifier(identifier, user_id)
        if hard:
            self.repo.hard_delete(UUID(memory["id"]), user_id)
        else:
            self.repo.soft_delete(UUID(memory["id"]), user_id)

    # -----------------------------------------------------------------------
    # Profile aggregation (fast path)
    # -----------------------------------------------------------------------

    def profile(
        self,
        user_id: UUID,
        query: Optional[str] = None,
        memory_limit: int = 10,
        experience_limit: int = 5,
    ) -> dict:
        """
        Fast aggregate for prompt hydration.

        Returns:
          - top personal memories (no semantic query: recency-ordered)
          - top collective experiences matching `query` (if provided)
        """
        memories = self.repo.top_memories(user_id=user_id, limit=memory_limit)

        experiences: list[dict] = []
        if query:
            try:
                q_emb = self.embedding.generate_topic_embedding(topic=query)
                experiences = self.experience_repo.search(
                    query_text=query,
                    query_embedding=q_emb,
                    match_count=experience_limit,
                )
            except Exception as e:
                logger.warning("Profile experience search failed: %s", e)
                experiences = []

        return {
            "user_id": str(user_id),
            "memories": memories,
            "experiences": experiences,
            "memory_count": len(memories),
            "generated_at": datetime.now(timezone.utc),
        }
