#!/usr/bin/env python3
"""Run LongMemEval against Plurum's memory provider.

For each question:
  1) Ingest every haystack_session turn pair into /memories/extract
     (scoped per-question via deterministic UUID5 → independent memory per eval)
  2) Search /memories/search with the question → top-K memories
  3) Feed memories + question to GPT-4o → hypothesis answer
  4) Checkpoint to out/hypothesis.jsonl

Then run LongMemEval's official judge on the hypothesis file.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

load_dotenv()

PLURUM_API_KEY = os.environ.get("PLURUM_API_KEY", "").strip()
PLURUM_API_URL = os.environ.get("PLURUM_API_URL", "https://api.plurum.ai").rstrip("/")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
LONGMEMEVAL_DIR = Path(os.environ.get("LONGMEMEVAL_DIR", Path.home() / "LongMemEval"))

# Default to gpt-5.4-mini; override via PLURUM_ANSWER_MODEL env var if needed.
ANSWER_MODEL = os.environ.get("PLURUM_ANSWER_MODEL", "gpt-5.4-mini")
TOP_K_MEMORIES = 20            # how many memories to retrieve per question
MAX_MEMORY_CHARS = 200         # per memory when shown to the answer model
REQUEST_TIMEOUT = 60.0

BENCH_DIR = Path(__file__).resolve().parent
OUT_DIR = BENCH_DIR / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)

DATASET_FILES = {
    "oracle": "longmemeval_oracle.json",
    "s":      "longmemeval_s_cleaned.json",
    "m":      "longmemeval_m_cleaned.json",
}

logging.basicConfig(level=logging.WARNING, format="%(message)s")
logger = logging.getLogger("plurum-lme")

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)

def _validate_env() -> None:
    if not PLURUM_API_KEY or PLURUM_API_KEY.endswith("REPLACE_ME"):
        _fail("PLURUM_API_KEY not set in .env")
    if not OPENAI_API_KEY or OPENAI_API_KEY.endswith("REPLACE_ME"):
        _fail("OPENAI_API_KEY not set in .env")
    if not LONGMEMEVAL_DIR.is_dir():
        _fail(f"LONGMEMEVAL_DIR does not exist: {LONGMEMEVAL_DIR}")

# ---------------------------------------------------------------------------
# Plurum HTTP client
# ---------------------------------------------------------------------------

class PlurimClient:
    def __init__(self):
        self.http = httpx.Client(
            base_url=PLURUM_API_URL,
            headers={
                "Authorization": f"Bearer {PLURUM_API_KEY}",
                "Content-Type": "application/json",
            },
            timeout=REQUEST_TIMEOUT,
        )

    def extract(
        self,
        user_id: str,
        user_msg: str,
        asst_msg: str,
        session_date: Optional[str] = None,
    ) -> int:
        """POST /memories/extract. Returns count of memories stored."""
        body = {
            "user_content": user_msg[:6000],
            "assistant_content": asst_msg[:6000],
        }
        if session_date:
            body["session_date"] = session_date
        try:
            r = self.http.post(
                "/api/v1/memories/extract",
                params={"user_id": user_id},
                json=body,
            )
            if r.status_code == 422:
                # Secret-scrub rejection. Skip this pair.
                return 0
            r.raise_for_status()
            return (r.json() or {}).get("count", 0)
        except httpx.HTTPError as e:
            logger.warning("extract failed: %s", e)
            return 0

    def search(self, user_id: str, query: str, limit: int = TOP_K_MEMORIES) -> list[str]:
        """POST /memories/search. Returns memory content strings."""
        try:
            r = self.http.post(
                "/api/v1/memories/search",
                params={"user_id": user_id},
                json={"query": query[:1000], "limit": limit},
            )
            r.raise_for_status()
            results = (r.json() or {}).get("results", []) or []
            return [
                (m.get("content") or "").strip()
                for m in results
                if isinstance(m, dict) and m.get("content")
            ]
        except httpx.HTTPError as e:
            logger.warning("search failed: %s", e)
            return []

# ---------------------------------------------------------------------------
# Answer generation
# ---------------------------------------------------------------------------

ANSWER_SYSTEM_PROMPT = (
    "You answer questions about a user using ONLY their stored memories.\n\n"
    "Rules:\n"
    "- Use only the memories provided. Do NOT use outside knowledge.\n"
    "- If the memories do not contain enough information, say you don't know.\n"
    "- For 'which happened first' questions, compare the dates/times in the memories. "
    "If one memory has a date and another only says 'recently' or 'two weeks ago', "
    "use the question date to anchor the relative time before comparing.\n"
    "- For 'how many days/weeks' questions, do the date arithmetic using the anchors "
    "in the memories.\n"
    "- Prefer the shortest possible factual answer — a phrase, date, count, or one-sentence statement.\n"
    "- Do not narrate, apologize, or restate the question.\n"
)


def generate_answer(
    openai_client: OpenAI,
    question: str,
    memories: list[str],
    question_date: Optional[str] = None,
) -> str:
    if not memories:
        mem_block = "(no memories available)"
    else:
        lines = [f"- {m[:MAX_MEMORY_CHARS]}" for m in memories]
        mem_block = "\n".join(lines)

    date_block = f"Question date: {question_date}\n\n" if question_date else ""

    prompt = (
        f"{date_block}"
        f"Memories about the user:\n{mem_block}\n\n"
        f"Question: {question}\n\n"
        f"Answer:"
    )

    # gpt-5.x / o1 models require max_completion_tokens.
    # Modern gpt-4o models accept it too. Use extra_body so this works on any
    # openai SDK version that supports chat.completions.create.
    try:
        resp = openai_client.chat.completions.create(
            model=ANSWER_MODEL,
            messages=[
                {"role": "system", "content": ANSWER_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            temperature=0.0,
            extra_body={"max_completion_tokens": 300},
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception as e:
        logger.warning("answer generation failed (model=%s): %s", ANSWER_MODEL, e)
        return ""

# ---------------------------------------------------------------------------
# User id scoping
# ---------------------------------------------------------------------------

def user_id_for_question(qid: str, run_tag: str) -> str:
    """Deterministic UUID5 so re-runs reuse the same memory; different run_tag = fresh bucket."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"plurum:benchmark:{run_tag}:{qid}"))

# ---------------------------------------------------------------------------
# Per-question work
# ---------------------------------------------------------------------------

def process_question(
    client: PlurimClient,
    openai_client: OpenAI,
    entry: dict,
    run_tag: str,
    skip_ingest: bool,
) -> tuple[str, str, int]:
    """Returns (question_id, hypothesis, extracted_count)."""
    qid = entry["question_id"]
    question = entry["question"]
    user_id = user_id_for_question(qid, run_tag)

    # 1) Ingest haystack_sessions (with session dates for temporal anchoring)
    extracted_total = 0
    if not skip_ingest:
        sessions = entry.get("haystack_sessions") or []
        haystack_dates = entry.get("haystack_dates") or []
        for idx, session in enumerate(sessions):
            if not isinstance(session, list):
                continue
            # Pair adjacent user→assistant turns
            session_date = haystack_dates[idx] if idx < len(haystack_dates) else None
            i = 0
            while i < len(session) - 1:
                t1, t2 = session[i], session[i + 1]
                if not isinstance(t1, dict) or not isinstance(t2, dict):
                    i += 1
                    continue
                if t1.get("role") == "user" and t2.get("role") == "assistant":
                    extracted_total += client.extract(
                        user_id=user_id,
                        user_msg=t1.get("content", ""),
                        asst_msg=t2.get("content", ""),
                        session_date=session_date,
                    )
                    i += 2
                else:
                    i += 1

    # 2) Retrieve
    memories = client.search(user_id=user_id, query=question)

    # 3) Answer (pass question_date so the LLM can do temporal arithmetic)
    hypothesis = generate_answer(
        openai_client,
        question,
        memories,
        question_date=entry.get("question_date"),
    )
    return qid, hypothesis, extracted_total

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def load_dataset(dataset_name: str) -> list[dict]:
    fname = DATASET_FILES[dataset_name]
    path = LONGMEMEVAL_DIR / "data" / fname
    if not path.is_file():
        _fail(f"Dataset not found: {path}\nRun setup.sh or download it from HuggingFace.")
    with path.open() as f:
        data = json.load(f)
    if not isinstance(data, list):
        _fail(f"Expected a list at the top of {path}, got {type(data).__name__}")
    return data

def load_existing_hypotheses(path: Path) -> set[str]:
    done: set[str] = set()
    if not path.is_file():
        return done
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                done.add(json.loads(line)["question_id"])
            except Exception:
                continue
    return done

def main() -> None:
    ap = argparse.ArgumentParser(description="Run LongMemEval against Plurum.")
    ap.add_argument("--dataset", choices=list(DATASET_FILES), default="oracle",
                    help="Which LongMemEval dataset to run (default: oracle)")
    ap.add_argument("--sample", type=int, default=None,
                    help="Only run first N questions (for quick sanity check)")
    ap.add_argument("--skip-done", action="store_true",
                    help="Skip questions already in the hypothesis file")
    ap.add_argument("--skip-ingest", action="store_true",
                    help="Skip ingestion step (useful for re-running just the answer step)")
    ap.add_argument("--run-tag", default="v1",
                    help="User-id namespace — change to force fresh memory on re-run")
    args = ap.parse_args()

    _validate_env()

    out_path = OUT_DIR / f"hypothesis-{args.dataset}-{args.run_tag}.jsonl"
    already_done = load_existing_hypotheses(out_path) if args.skip_done else set()

    data = load_dataset(args.dataset)
    if args.sample:
        data = data[: args.sample]

    client = PlurimClient()
    openai_client = OpenAI(api_key=OPENAI_API_KEY)

    print(f"Running {len(data)} questions from longmemeval_{args.dataset}.json")
    print(f"Writing hypotheses to: {out_path}")
    if already_done:
        print(f"Skipping {len(already_done)} already-done questions")

    t_start = time.time()
    extracted_total = 0
    questions_processed = 0

    with out_path.open("a") as fh:
        for entry in tqdm(data, desc="questions", unit="q"):
            qid = entry.get("question_id")
            if not qid or qid in already_done:
                continue

            try:
                qid, hypothesis, ext = process_question(
                    client, openai_client, entry, args.run_tag, args.skip_ingest
                )
                extracted_total += ext
                questions_processed += 1
                fh.write(json.dumps({"question_id": qid, "hypothesis": hypothesis}) + "\n")
                fh.flush()

                # Fail-loud: if we've processed 5 questions and extracted zero memories,
                # the backend extract endpoint is broken. Abort instead of burning hours.
                if (not args.skip_ingest
                    and questions_processed == 5
                    and extracted_total == 0):
                    print(
                        "\n!! 5 questions processed, 0 memories extracted. "
                        "Backend /memories/extract is likely returning errors "
                        "(model id, auth, or 500s). Aborting. Check PLURUM_EXTRACTION_MODEL "
                        "in Vercel env vars and the backend logs.",
                        file=sys.stderr,
                    )
                    sys.exit(2)
            except KeyboardInterrupt:
                print("\nInterrupted. Hypothesis file is checkpointed — resume with --skip-done.")
                sys.exit(130)
            except Exception as e:
                logger.warning("question %s failed: %s", qid, e)
                fh.write(json.dumps({"question_id": qid, "hypothesis": ""}) + "\n")
                fh.flush()

    elapsed = time.time() - t_start
    print(f"\nDone in {elapsed:.1f}s")
    print(f"Memories extracted: {extracted_total}")
    print(f"Hypothesis file: {out_path}")
    print()
    print("Next: run the judge")
    print(f"  cd {LONGMEMEVAL_DIR}/src/evaluation")
    print(f"  python3 evaluate_qa.py gpt-4o {out_path} "
          f"{LONGMEMEVAL_DIR}/data/{DATASET_FILES[args.dataset]}")


if __name__ == "__main__":
    main()
