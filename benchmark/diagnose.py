#!/usr/bin/env python3
"""Diagnose benchmark failures.

For every failed question, show:
  - the question
  - the ground truth
  - our hypothesis
  - what question_type it is
  - the memories we retrieved at judge-time (optional — can be slow if many)

Usage:
  python diagnose.py <eval_results_file> <dataset_file>
  python diagnose.py ~/plurum/benchmark/out/hypothesis-oracle-v2.jsonl.eval-results-gpt-4o \\
                     ~/LongMemEval/data/longmemeval_oracle.json
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from collections import Counter
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv()

PLURUM_API_KEY = os.environ.get("PLURUM_API_KEY", "").strip()
PLURUM_API_URL = os.environ.get("PLURUM_API_URL", "https://api.plurum.ai").rstrip("/")


def user_id_for(qid: str, run_tag: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"plurum:benchmark:{run_tag}:{qid}"))


def fetch_memories(user_id: str, query: str, limit: int = 10) -> list[str]:
    if not PLURUM_API_KEY:
        return []
    try:
        r = httpx.post(
            f"{PLURUM_API_URL}/api/v1/memories/search",
            headers={"Authorization": f"Bearer {PLURUM_API_KEY}"},
            params={"user_id": user_id},
            json={"query": query[:1000], "limit": limit},
            timeout=20.0,
        )
        r.raise_for_status()
        return [
            (m.get("content") or "").strip()
            for m in (r.json() or {}).get("results", [])
            if isinstance(m, dict)
        ]
    except Exception as e:
        return [f"(search failed: {e})"]


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    results_path = Path(sys.argv[1]).expanduser()
    dataset_path = Path(sys.argv[2]).expanduser()
    run_tag = sys.argv[3] if len(sys.argv) > 3 else "v2"
    show_memories = "--no-memories" not in sys.argv

    # Load dataset for ground truth + question_type
    with dataset_path.open() as f:
        dataset = {d["question_id"]: d for d in json.load(f)}

    # Load eval results
    results = []
    with results_path.open() as f:
        for line in f:
            line = line.strip()
            if line:
                results.append(json.loads(line))

    # Tally
    total = len(results)
    type_counts = Counter()
    type_correct = Counter()
    for r in results:
        entry = dataset.get(r["question_id"], {})
        qtype = entry.get("question_type", "unknown")
        type_counts[qtype] += 1
        label = r["autoeval_label"]
        correct = label.get("label") if isinstance(label, dict) else bool(label)
        if correct:
            type_correct[qtype] += 1

    print("=" * 70)
    print(f"Total: {total}  Correct: {sum(type_correct.values())}  "
          f"Accuracy: {sum(type_correct.values())/total:.1%}")
    print("By category:")
    for qt in sorted(type_counts):
        c, n = type_correct[qt], type_counts[qt]
        print(f"  {qt:34s} {c}/{n} = {c/n:.1%}")
    print("=" * 70)

    # Details on failures
    print("\nFAILURES:\n")
    for r in results:
        label = r["autoeval_label"]
        correct = label.get("label") if isinstance(label, dict) else bool(label)
        if correct:
            continue
        qid = r["question_id"]
        entry = dataset.get(qid, {})
        print(f"[{entry.get('question_type', '?'):30s}] {qid}")
        print(f"  Q: {entry.get('question', '')[:200]}")
        print(f"  GT:    {entry.get('answer', '')[:200]}")
        print(f"  OURS:  {r.get('hypothesis', '')[:200]}")
        if show_memories and entry.get("question"):
            uid = user_id_for(qid, run_tag)
            mems = fetch_memories(uid, entry["question"], limit=5)
            if mems:
                print(f"  TOP 5 MEMORIES WE FOUND:")
                for m in mems:
                    print(f"    - {m[:200]}")
        print()


if __name__ == "__main__":
    main()
