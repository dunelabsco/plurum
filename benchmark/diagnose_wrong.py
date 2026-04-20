#!/usr/bin/env python3
"""Diagnose where a LongMemEval run went wrong.

For every question the judge marked wrong in a given category, print:
  - Question, gold answer, our hypothesis
  - What memories we STORED for that question's scoped user (how many, first 5 contents)
  - What memories we RETRIEVED when searching with the question

This tells you at a glance whether failures are:
  (a) extraction — the fact never made it into memory
  (b) retrieval — it's stored but search didn't find it
  (c) answering — memory was found but the model still answered wrong

Usage:
    python diagnose_wrong.py \\
        --category single-session-preference \\
        --run-tag v14-oracle-mixed \\
        --dataset oracle
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv()

PLURUM_API_KEY = os.environ.get("PLURUM_API_KEY", "").strip()
PLURUM_API_URL = os.environ.get("PLURUM_API_URL", "https://api.plurum.ai").rstrip("/")
LONGMEMEVAL_DIR = Path(os.environ.get("LONGMEMEVAL_DIR", Path.home() / "LongMemEval"))

BENCH_DIR = Path(__file__).resolve().parent
OUT_DIR = BENCH_DIR / "out"

DATASET_FILES = {
    "oracle": "longmemeval_oracle.json",
    "s":      "longmemeval_s_cleaned.json",
    "m":      "longmemeval_m_cleaned.json",
}


def user_id_for_question(qid: str, run_tag: str) -> str:
    """Must match run.py's scoping exactly."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"plurum:benchmark:{run_tag}:{qid}"))


def load_eval_results(path: Path) -> dict[str, bool]:
    """LongMemEval judge output — jsonl where each row is the original entry
    plus a judgment. We try a few common field names and fall back to printing
    the first row so you can tell me what to look for."""
    results: dict[str, bool] = {}
    if not path.is_file():
        sys.exit(f"eval results file not found: {path}")

    with path.open() as f:
        lines = [ln.strip() for ln in f if ln.strip()]
    if not lines:
        sys.exit("eval file is empty")

    def _extract(row: dict):
        # LME judge writes {"autoeval_label": {"model": "...", "label": true}}
        ae = row.get("autoeval_label")
        if isinstance(ae, dict) and "label" in ae:
            return ae["label"]
        for k in ("is_correct", "correct", "label", "judgment", "score"):
            if k in row:
                return row[k]
        return None

    first = json.loads(lines[0])
    if _extract(first) is None:
        print(f"[warn] couldn't identify correctness field; first row keys: {list(first.keys())}",
              file=sys.stderr)
        print(f"[warn] first row: {json.dumps(first)[:500]}", file=sys.stderr)
        sys.exit("edit diagnose_wrong.py:load_eval_results to pick the right field")

    for ln in lines:
        row = json.loads(ln)
        qid = row.get("question_id")
        if not qid:
            continue
        val = _extract(row)
        # Normalize: True/1/"yes"/"correct" -> correct
        if isinstance(val, bool):
            ok = val
        elif isinstance(val, (int, float)):
            ok = val >= 0.5
        elif isinstance(val, str):
            ok = val.strip().lower() in ("yes", "correct", "true", "1")
        else:
            ok = False
        results[qid] = ok

    return results


def load_hypotheses(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    with path.open() as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            row = json.loads(ln)
            out[row["question_id"]] = row.get("hypothesis", "")
    return out


def list_memories(client: httpx.Client, user_id: str) -> list[dict]:
    r = client.get(
        "/api/v1/memories",
        params={"user_id": user_id, "limit": 200},
    )
    if r.status_code != 200:
        return []
    return (r.json() or {}).get("items", []) or []


def search_memories(client: httpx.Client, user_id: str, query: str) -> list[dict]:
    r = client.post(
        "/api/v1/memories/search",
        params={"user_id": user_id},
        json={"query": query[:1000], "limit": 10},
    )
    if r.status_code != 200:
        return []
    return (r.json() or {}).get("results", []) or []


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--category", required=True)
    ap.add_argument("--run-tag", required=True)
    ap.add_argument("--dataset", choices=list(DATASET_FILES), default="oracle")
    ap.add_argument("--max", type=int, default=20,
                    help="Max wrong questions to show (default 20)")
    args = ap.parse_args()

    if not PLURUM_API_KEY:
        sys.exit("PLURUM_API_KEY not set")

    data_path = LONGMEMEVAL_DIR / "data" / DATASET_FILES[args.dataset]
    hypo_path = OUT_DIR / f"hypothesis-{args.dataset}-{args.run_tag}.jsonl"
    eval_path = hypo_path.with_name(hypo_path.name + ".eval-results-gpt-4o")

    print(f"dataset:     {data_path}")
    print(f"hypotheses:  {hypo_path}")
    print(f"eval judge:  {eval_path}")
    print()

    with data_path.open() as f:
        data = {d["question_id"]: d for d in json.load(f)}
    hypos = load_hypotheses(hypo_path)
    evals = load_eval_results(eval_path)

    wrong = [
        qid for qid, ok in evals.items()
        if not ok
        and data.get(qid, {}).get("question_type") == args.category
    ]
    print(f"[{args.category}] wrong: {len(wrong)}")
    if not wrong:
        return

    client = httpx.Client(
        base_url=PLURUM_API_URL,
        headers={
            "Authorization": f"Bearer {PLURUM_API_KEY}",
            "Content-Type": "application/json",
        },
        timeout=30.0,
    )

    for i, qid in enumerate(wrong[: args.max], 1):
        entry = data[qid]
        question = entry.get("question", "")
        gold = entry.get("answer") or entry.get("answers") or entry.get("reference_answer")
        hypo = hypos.get(qid, "<none>")
        user_id = user_id_for_question(qid, args.run_tag)

        stored = list_memories(client, user_id)
        retrieved = search_memories(client, user_id, question)

        print("=" * 78)
        print(f"[{i}/{len(wrong)}] {qid}")
        print(f"Q:      {question}")
        print(f"GOLD:   {gold}")
        print(f"OURS:   {hypo}")
        print(f"stored: {len(stored)} memories (showing first 5):")
        for m in stored[:5]:
            print(f"   - {(m.get('content') or '')[:180]}")
        print(f"retrieved top-{len(retrieved)} for this question:")
        for m in retrieved:
            score = m.get("combined_score") or m.get("rerank_score") or m.get("similarity")
            print(f"   - [{score}] {(m.get('content') or '')[:180]}")
        print()

    client.close()


if __name__ == "__main__":
    main()
