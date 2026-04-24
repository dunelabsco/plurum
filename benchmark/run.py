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
from concurrent.futures import ThreadPoolExecutor, as_completed
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

# Default answer model: gpt-4o-mini. Hindsight's LongMemEval benchmark uses
# gpt-4o-mini with reasoning_effort="high" — we can't crank reasoning on a
# non-reasoning model, but gpt-4o-mini is still what they hit SOTA with.
# Override via PLURUM_ANSWER_MODEL env var.
ANSWER_MODEL = os.environ.get("PLURUM_ANSWER_MODEL", "gpt-4o-mini")
# Mem0 and Hindsight default to 30 retrieved memories. Our old 20 was
# starving aggregation/counting questions that need to see every instance.
TOP_K_MEMORIES = int(os.environ.get("PLURUM_TOP_K", "30"))
# 200 chars was truncating lists/tables mid-content — the 7th item in a
# 15-item list never reached the answer model. 2000 comfortably fits a
# 10-row shift schedule, a 15-item job list, or a dense multi-paragraph
# assistant answer without inflating the prompt to absurd sizes.
MAX_MEMORY_CHARS = 2000
REQUEST_TIMEOUT = 180.0  # extracts under concurrent load + slow OpenAI calls can legitimately take 60-90s; 180s leaves headroom without hiding real hangs
INGEST_PARALLELISM = int(os.environ.get("PLURUM_INGEST_PARALLELISM", "8"))

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

    # -- HTTP retry helper ---------------------------------------------------
    # Backend transient failures (5xx, timeouts) during long benchmark runs
    # caused the v12 catastrophe — 100 consecutive search 500s after Q~400.
    # Defensive retry with backoff means transient hiccups don't lose questions.
    _RETRY_MAX_ATTEMPTS = 4
    _RETRY_BASE_DELAY = 1.5

    def _request_with_retry(self, method: str, path: str, **kwargs) -> httpx.Response:
        last_exc: Optional[Exception] = None
        for attempt in range(self._RETRY_MAX_ATTEMPTS):
            try:
                r = self.http.request(method, path, **kwargs)
                # Don't retry 4xx — those are our bugs or intentional (422 secret scrub)
                if 500 <= r.status_code < 600:
                    raise httpx.HTTPStatusError(
                        f"server {r.status_code}", request=r.request, response=r,
                    )
                return r
            except (httpx.HTTPStatusError, httpx.TransportError, httpx.TimeoutException) as e:
                last_exc = e
                if attempt == self._RETRY_MAX_ATTEMPTS - 1:
                    break
                delay = self._RETRY_BASE_DELAY * (2 ** attempt)
                logger.info(
                    "HTTP %s %s attempt %d/%d failed (%s) — retrying in %.1fs",
                    method, path, attempt + 1, self._RETRY_MAX_ATTEMPTS,
                    type(e).__name__, delay,
                )
                time.sleep(delay)
        assert last_exc is not None
        raise last_exc

    def extract(
        self,
        user_id: str,
        user_msg: str,
        asst_msg: str,
        session_date: Optional[str] = None,
        messages: Optional[list[dict]] = None,
    ) -> int:
        """POST /memories/extract. Returns count of memories stored.

        `messages` is the prior turns of the current session (oldest first),
        used by the extractor for anaphora resolution. Caller trims the
        list; we forward up to the last 10 turns.
        """
        body = {
            "user_content": user_msg[:6000],
            "assistant_content": asst_msg[:6000],
        }
        if session_date:
            body["session_date"] = session_date
        if messages:
            # Keep the payload bounded — last 10 turns is what the extractor
            # prompt consumes anyway. Each turn content capped at 2000 chars.
            trimmed = []
            for m in messages[-10:]:
                if not isinstance(m, dict):
                    continue
                role = m.get("role")
                content = (m.get("content") or "")[:2000]
                if role in ("user", "assistant") and content:
                    trimmed.append({"role": role, "content": content})
            if trimmed:
                body["messages"] = trimmed
        try:
            r = self._request_with_retry(
                "POST",
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
            logger.warning("extract failed after retries: %s", e)
            return 0

    def search(self, user_id: str, query: str, limit: int = TOP_K_MEMORIES) -> list[dict]:
        """POST /memories/search. Returns full memory rows.

        Each row includes content plus event_date_start/end, mentioned_at,
        source_user, source_assistant — the answer prompt formats these into
        a Fact/When/Source block (Hindsight-style) so the model sees both
        the extracted summary and the original conversation text.
        """
        try:
            r = self._request_with_retry(
                "POST",
                "/api/v1/memories/search",
                params={"user_id": user_id},
                json={"query": query[:1000], "limit": limit},
            )
            r.raise_for_status()
            results = (r.json() or {}).get("results", []) or []
            return [m for m in results if isinstance(m, dict) and m.get("content")]
        except httpx.HTTPError as e:
            logger.warning("search failed after retries: %s", e)
            return []

# ---------------------------------------------------------------------------
# Answer generation
# ---------------------------------------------------------------------------

ANSWER_SYSTEM_PROMPT = (
    # Rules adapted from Hindsight's LongMemEval answer prompt
    # (research/hindsight/hindsight-dev/benchmarks/longmemeval/).
    "You answer questions about a user using ONLY their stored memories.\n\n"
    "## Understanding the retrieved context\n"
    "Each memory is shown as:\n"
    "  Fact N: <extracted summary>\n"
    "  When: occurred=<date> | mentioned=<date>\n"
    "  Source:\n"
    "    USER: <original user turn>\n"
    "    ASSISTANT: <original assistant turn>\n\n"
    "The Fact is a summary. The Source is the raw conversation. Prefer the Source\n"
    "for specifics, quantities, names, and counts — the summary may elide detail.\n"
    "Use the occurred date to answer 'when did X happen'; use the mentioned date\n"
    "to anchor relative references like 'last Friday' inside a memory.\n\n"
    "## Date arithmetic\n"
    "- Days between two dates = (B - A). Jan 1 to Jan 8 = 7 days, not 8.\n"
    "- Convert every relative reference to an absolute date before comparing.\n"
    "  Anchor in-memory references ('two weeks ago', 'last Friday') to that\n"
    "  memory's mentioned date. Anchor in-question references to the question date.\n"
    "- Double-check arithmetic; off-by-one errors are common.\n\n"
    "## Counting questions ('how many X')\n"
    "- Scan ALL facts before answering. Don't stop after finding a few.\n"
    "- List each unique item explicitly in your reasoning: '1. X, 2. Y, 3. Z = 3'.\n"
    "- Deduplicate aggressively. The same underlying event, person, or item often\n"
    "  appears in multiple memories from different angles. Assume overlap by\n"
    "  default unless there is clear evidence the mentions refer to different\n"
    "  things. 'My college roommate's wedding' and 'Emily's wedding' may be the\n"
    "  same wedding; 'Dr. Smith (PCP)' and 'the primary care physician' may be\n"
    "  the same doctor; two fixings of 'the kitchen shelves' in the same month\n"
    "  are likely one event. When in doubt, undercount — one false duplicate\n"
    "  hurts more than one missed distinct item.\n"
    "- Read qualifiers carefully: 'how many X before Y' counts X, not Y.\n"
    "  'How many properties before the offer' counts OTHER properties.\n"
    "- Include the user themselves when the group naturally contains them\n"
    "  ('me and my parents' = 3 people, not 2).\n"
    "- For sums/averages: list every numeric value you find from the memories,\n"
    "  then add or average. Don't skip values present in the memories.\n\n"
    "## Superlative questions ('which X had the most')\n"
    "- Compare actual magnitudes across all candidates. A specifically-stated\n"
    "  number is not automatically larger than an approximately-stated one;\n"
    "  compare the numbers themselves.\n\n"
    "## Recommendation / preference questions\n"
    "- Do NOT invent specific product names, course titles, or brand names.\n"
    "- DO mention brands or tools the user already uses from their memories.\n"
    "- Describe what kind of recommendation the user would prefer, referencing\n"
    "  their existing habits and stated preferences.\n\n"
    "## When to say you don't know\n"
    "- If the question asks about something absent from the memories, say so.\n"
    "- Partial knowledge is fine: if the question has two parts and the\n"
    "  memories cover one, answer that one and note the other is missing.\n"
    "- Don't guess dates or facts not explicit in the memories.\n\n"
    "## Answer format\n"
    "- Emit the short final answer: a phrase, date, count, name, or single\n"
    "  sentence. Do not show your working. Do not restate the question.\n"
    "- Do not apologize or narrate.\n"
)

# Preference questions get a different treatment. The LME gold answers for this
# category are aspirational profile summaries of the form "the user would prefer X
# because of their history with Y; they may not prefer Z". A terse factual answer
# always scores as wrong here, even when the underlying recall is perfect.
PREFERENCE_SYSTEM_PROMPT = (
    "You answer a question on behalf of a user based ONLY on their stored memories.\n\n"
    "Rules:\n"
    "- Use only the memories provided. Do NOT use outside knowledge.\n"
    "- Produce a 2–4 sentence response that reflects the user's profile, not just a\n"
    "  terse fact. Reference their past experiences, habits, and stated preferences\n"
    "  when they are relevant to the question.\n"
    "- If the memories show what the user LIKES or has DONE, weave those into the\n"
    "  suggestion. If they show what the user DISLIKES or wants to AVOID, mention that\n"
    "  contrast explicitly (e.g., 'they would prefer X rather than Y').\n"
    "- Prefer specific, personal suggestions over generic ones. If a memory says the\n"
    "  user made a lemon poppyseed cake before, suggest variations on that — not\n"
    "  random baking ideas.\n"
    "- Do not apologize or restate the question.\n"
)


def _format_date(value) -> Optional[str]:
    """Strip a Postgres timestamp to YYYY-MM-DD for answer-model display."""
    if not value:
        return None
    s = str(value)
    return s[:10] if len(s) >= 10 else s


def _render_memory(idx: int, mem: dict) -> str:
    """Hindsight-style Fact/When/Source block for a single memory."""
    content = (mem.get("content") or "").strip()[:MAX_MEMORY_CHARS]
    mem_type = (mem.get("memory_type") or "fact")
    parts = [f"Fact {idx} ({mem_type}): {content}"]

    occurred_start = _format_date(mem.get("event_date_start"))
    occurred_end = _format_date(mem.get("event_date_end"))
    mentioned = _format_date(mem.get("mentioned_at")) or _format_date(mem.get("created_at"))
    when_bits: list[str] = []
    if occurred_start:
        if occurred_end and occurred_end != occurred_start:
            when_bits.append(f"occurred={occurred_start}..{occurred_end}")
        else:
            when_bits.append(f"occurred={occurred_start}")
    if mentioned:
        when_bits.append(f"mentioned={mentioned}")
    if when_bits:
        parts.append("When: " + " | ".join(when_bits))

    src_user = (mem.get("source_user") or "").strip()
    src_asst = (mem.get("source_assistant") or "").strip()
    if src_user or src_asst:
        src_lines = ["Source:"]
        if src_user:
            src_lines.append(f"  USER: {src_user[:1200]}")
        if src_asst:
            src_lines.append(f"  ASSISTANT: {src_asst[:1200]}")
        parts.append("\n".join(src_lines))

    return "\n".join(parts)


def generate_answer(
    openai_client: OpenAI,
    question: str,
    memories: list[dict],
    question_date: Optional[str] = None,
    question_type: Optional[str] = None,
) -> str:
    if not memories:
        mem_block = "(no memories available)"
    else:
        blocks = [_render_memory(i + 1, m) for i, m in enumerate(memories)]
        mem_block = "\n\n---\n\n".join(blocks)

    date_block = f"Question date: {question_date}\n\n" if question_date else ""

    prompt = (
        f"{date_block}"
        f"Retrieved memories:\n\n{mem_block}\n\n"
        f"Question: {question}\n\n"
        f"Answer:"
    )

    # Reasoning models (gpt-5.x, o1, o3) reject `temperature` and `max_tokens`.
    # They accept ONLY `max_completion_tokens`, which includes internal reasoning
    # tokens — so we budget generously (2000) to avoid empty outputs from the
    # model burning its whole budget on reasoning.
    #
    # gpt-4o also accepts max_completion_tokens, so one code path works for both.
    is_reasoning_model = any(
        tag in ANSWER_MODEL.lower()
        for tag in ("gpt-5", "o1-", "o3-", "o4-")
    )
    system_prompt = (
        PREFERENCE_SYSTEM_PROMPT
        if question_type == "single-session-preference"
        else ANSWER_SYSTEM_PROMPT
    )
    kwargs: dict = {
        "model": ANSWER_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "extra_body": {"max_completion_tokens": 2000},
    }
    if not is_reasoning_model:
        # gpt-4o and older accept temperature; reasoning models reject it.
        kwargs["temperature"] = 0.0

    try:
        resp = openai_client.chat.completions.create(**kwargs)
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
    # Each question has 50-200+ turn pairs; running them serially meant the
    # full benchmark took 25+ hours. We fan out extract calls across a thread
    # pool — the backend is fine with concurrent writes to the same user_id
    # and the per-call latency (~3-6s) means even modest parallelism saves
    # multiple hours per 50-question run.
    extracted_total = 0
    if not skip_ingest:
        sessions = entry.get("haystack_sessions") or []
        haystack_dates = entry.get("haystack_dates") or []

        # Group pairs BY session so we can process them sequentially within
        # one session (preserving conversation order for anaphora) while still
        # parallelizing across sessions. Previously every pair from every
        # session was shuffled into one big parallel pool — turn 5 could
        # race turn 3, and the extractor never saw prior turns.
        per_session_pairs: list[tuple[Optional[str], list[tuple[str, str]]]] = []
        for idx, session in enumerate(sessions):
            if not isinstance(session, list):
                continue
            session_date = haystack_dates[idx] if idx < len(haystack_dates) else None
            pairs: list[tuple[str, str]] = []
            i = 0
            while i < len(session) - 1:
                t1, t2 = session[i], session[i + 1]
                if not isinstance(t1, dict) or not isinstance(t2, dict):
                    i += 1
                    continue
                if t1.get("role") == "user" and t2.get("role") == "assistant":
                    pairs.append((t1.get("content", ""), t2.get("content", "")))
                    i += 2
                else:
                    i += 1
            if pairs:
                per_session_pairs.append((session_date, pairs))

        def _process_session(session_date: Optional[str], pairs: list[tuple[str, str]]) -> int:
            """Extract every pair in a session serially, feeding a rolling
            conversation history into each extract call so the extractor can
            resolve pronouns against earlier turns in the same session."""
            history: list[dict] = []
            count = 0
            for user_msg, asst_msg in pairs:
                count += client.extract(
                    user_id=user_id,
                    user_msg=user_msg,
                    asst_msg=asst_msg,
                    session_date=session_date,
                    messages=history[-20:] if history else None,
                ) or 0
                # Append AFTER the extract completes so the next turn sees
                # the full prior state. Cap to last 40 entries (≈20 turns)
                # so memory doesn't grow unbounded on long sessions.
                history.append({"role": "user", "content": user_msg})
                history.append({"role": "assistant", "content": asst_msg})
                if len(history) > 40:
                    history = history[-40:]
            return count

        if per_session_pairs:
            with ThreadPoolExecutor(max_workers=INGEST_PARALLELISM) as pool:
                futures = [
                    pool.submit(_process_session, d, pairs)
                    for (d, pairs) in per_session_pairs
                ]
                for fut in as_completed(futures):
                    extracted_total += fut.result() or 0

    # 2) Retrieve
    memories = client.search(user_id=user_id, query=question)

    # 3) Answer (pass question_date so the LLM can do temporal arithmetic;
    # pass question_type so preference questions get the profile-aware prompt)
    hypothesis = generate_answer(
        openai_client,
        question,
        memories,
        question_date=entry.get("question_date"),
        question_type=entry.get("question_type"),
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
    ap.add_argument("--shuffle", action="store_true",
                    help="Shuffle dataset with a fixed seed before --sample so "
                         "you get a mix across categories (the raw file is "
                         "sorted by category, so --sample 100 otherwise picks "
                         "100 of whatever comes first)")
    ap.add_argument("--category", default=None,
                    help="Filter to a single question_type (e.g. temporal-reasoning, "
                         "single-session-user, single-session-assistant, "
                         "single-session-preference, knowledge-update, multi-session)")
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
    if args.category:
        before = len(data)
        data = [d for d in data if d.get("question_type") == args.category]
        print(f"Filtered to category={args.category}: {len(data)}/{before} questions")
        if not data:
            _fail(
                f"No questions with question_type={args.category!r} in this dataset. "
                f"Check category spelling (hyphens, not underscores)."
            )
    if args.shuffle:
        import random
        random.Random(42).shuffle(data)
        print(f"Shuffled dataset (seed=42) before sampling")
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
