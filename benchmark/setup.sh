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
mkdir -p "$LONGMEM_DIR/data"
if [ ! -f "$LONGMEM_DIR/data/longmemeval_oracle.json" ]; then
  echo "Downloading LongMemEval oracle dataset..."
  # Their dataset is hosted on HuggingFace. Follow their README if this URL changes.
  curl -L -o "$LONGMEM_DIR/data/longmemeval_oracle.json" \
    "https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/longmemeval_oracle.json" || {
    echo ""
    echo "!! Could not auto-download the dataset."
    echo "   Please grab it manually from https://huggingface.co/datasets/xiaowu0162/LongMemEval"
    echo "   and drop longmemeval_oracle.json into $LONGMEM_DIR/data/"
  }
fi

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
