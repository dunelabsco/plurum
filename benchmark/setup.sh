#!/usr/bin/env bash
# Plurum LongMemEval benchmark setup.
# Installs LongMemEval harness into $HOME/LongMemEval, sets up a Python venv here.
set -euo pipefail

echo "=== Plurum LongMemEval setup ==="

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LONGMEM_DIR="${HOME}/LongMemEval"

# -- System packages ---------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
  echo "Installing python3..."
  sudo apt-get update -qq && sudo apt-get install -y python3 python3-venv python3-pip
fi
if ! command -v git >/dev/null 2>&1; then
  sudo apt-get install -y git
fi
if ! command -v jq >/dev/null 2>&1; then
  sudo apt-get install -y jq
fi

# -- LongMemEval repo --------------------------------------------------------
if [ ! -d "$LONGMEM_DIR" ]; then
  echo "Cloning LongMemEval into $LONGMEM_DIR..."
  git clone --depth 1 https://github.com/xiaowu0162/LongMemEval.git "$LONGMEM_DIR"
else
  echo "LongMemEval already cloned at $LONGMEM_DIR"
fi

# -- Datasets ----------------------------------------------------------------
# HuggingFace dataset: xiaowu0162/longmemeval-cleaned
# Files: longmemeval_oracle.json, longmemeval_s_cleaned.json, longmemeval_m_cleaned.json
mkdir -p "$LONGMEM_DIR/data"
HF_BASE="https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main"

download_if_missing() {
  local fname="$1"
  local dest="$LONGMEM_DIR/data/$fname"
  # Re-download if file is missing OR tiny (<1KB means a prior 404 saved an error stub)
  if [ ! -f "$dest" ] || [ "$(wc -c < "$dest")" -lt 1024 ]; then
    echo "Downloading $fname ..."
    curl -fL -o "$dest" "$HF_BASE/$fname" && return 0
    echo "  !! failed — tried $HF_BASE/$fname"
    rm -f "$dest"
    return 1
  fi
}

download_if_missing "longmemeval_oracle.json" || true
# Bigger files — optional for first run. Uncomment if you want them pre-downloaded.
# download_if_missing "longmemeval_s_cleaned.json" || true
# download_if_missing "longmemeval_m_cleaned.json" || true

# -- Python venv (for the harness only) --------------------------------------
cd "$BENCH_DIR"
if [ ! -d "venv" ]; then
  echo "Creating venv..."
  python3 -m venv venv
fi

# shellcheck disable=SC1091
source venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

# -- .env template -----------------------------------------------------------
if [ ! -f ".env" ]; then
  cat > .env <<'EOF'
# Plurum credentials
PLURUM_API_KEY=plrm_live_REPLACE_ME
PLURUM_API_URL=https://api.plurum.ai

# OpenAI (used for the ANSWER step + LongMemEval judge)
OPENAI_API_KEY=sk-REPLACE_ME

# LongMemEval data directory
LONGMEMEVAL_DIR=__HOME__/LongMemEval
EOF
  # Expand ~ to actual HOME
  sed -i.bak "s|__HOME__|$HOME|g" .env && rm -f .env.bak
  echo ""
  echo "Created .env template. Edit it with your keys:"
  echo "  nano $BENCH_DIR/.env"
fi

echo ""
echo "=== Setup done. ==="
echo ""
echo "Next steps:"
echo "  1) Edit: $BENCH_DIR/.env  (add your PLURUM_API_KEY + OPENAI_API_KEY)"
echo "  2) Run:  cd $BENCH_DIR && source venv/bin/activate && python run.py --sample 50"
