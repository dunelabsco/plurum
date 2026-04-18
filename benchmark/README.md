# Plurum LongMemEval Harness

Run the [LongMemEval](https://github.com/xiaowu0162/LongMemEval) benchmark against Plurum's memory provider.

This produces a **hypothesis file** (JSONL with `question_id` + `hypothesis`) that you feed to LongMemEval's official judge script. The judge is GPT-4o. The final score is the percentage of correct answers.

---

## What the harness does

For each question in the dataset:

1. **Ingest** — walk every `haystack_session` turn-pair and POST to `/memories/extract`. The LLM on our backend extracts durable memories and stores them under a deterministic per-question `user_id`.
2. **Retrieve** — POST the question to `/memories/search`. Get top-K memories back.
3. **Answer** — feed memories + question to GPT-4o. Get a free-form answer.
4. **Log** — append `{question_id, hypothesis}` to the hypothesis file.

Then LongMemEval's `evaluate_qa.py` runs the judge over the hypothesis file and prints accuracy.

---

## VPS setup (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/dunelabsco/plurum/main/benchmark/setup.sh | bash
```

Or manually:

```bash
cd ~
git clone https://github.com/dunelabsco/plurum.git
cd plurum/benchmark
bash setup.sh
```

Setup does:

- Installs Python 3.11+, git, jq if missing
- Clones LongMemEval into `~/LongMemEval`
- Installs its Python deps into a venv
- Downloads the oracle dataset (smallest, cheapest to start with)
- Creates a `.env` template for you to fill in

---

## Run

```bash
cd ~/plurum/benchmark
source venv/bin/activate

# Edit .env first — set PLURUM_API_KEY and OPENAI_API_KEY
nano .env

# Small sanity check (50 questions, oracle dataset, ~$3-5)
python run.py --dataset oracle --sample 50

# Full run on oracle (500 questions, ~$30-40)
python run.py --dataset oracle

# Full LongMemEval-S (500 questions × ~40 sessions, ~$100-150)
python run.py --dataset s
```

---

## Cost estimates

| Dataset | Sessions/q | Extract calls | Total cost |
|---|---|---|---|
| oracle | ~2-5 | ~2,500 | ~$30-40 |
| s (LongMemEval-S) | ~40 | ~20,000 | ~$100-150 |
| m (LongMemEval-M) | ~500 | ~250,000 | ~$1,500+ |

Extract calls use `gpt-4o-mini` on the Plurum backend. Answer + judge use `gpt-4o`. Embedding calls are cheap.

**Start with oracle + --sample 50** before burning any serious money.

---

## Output

- `out/hypothesis.jsonl` — model's answers (one line per question)
- `out/graded.json` — after judging, contains `autoeval_label` per question
- `out/summary.txt` — final accuracy numbers per question_type

---

## Troubleshooting

**Ingest is slow:** expected. LongMemEval-S ingests ~40 sessions × ~10 turn-pairs per question. Each extract is a separate GPT-4o-mini call on our backend. Budget ~30-60 minutes for a 50-question sample.

**Cost running high:** kill with Ctrl-C. The hypothesis file is checkpointed after each question, so you can resume with `--skip-done`.

**Getting 422 errors:** the API rejected content containing secrets. Usually fine — LongMemEval sometimes has synthetic tokens. Those questions get skipped.
