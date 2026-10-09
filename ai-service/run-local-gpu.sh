#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
model=qwen2.5:3b
ollama_port=11435
web_port=8766
ollama_pid=
install=0

for arg in "$@"; do
  case "$arg" in
    --install) install=1 ;;
    qwen2.5:0.5b|qwen2.5:1.5b|qwen2.5:3b) model=$arg ;;
    *)
      printf 'Usage: bash ai-service/run-local-gpu.sh [--install] [qwen2.5:0.5b|qwen2.5:1.5b|qwen2.5:3b]\n' >&2
      exit 1
      ;;
  esac
done

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  printf 'This launcher is for Apple Silicon Macs.\n' >&2
  exit 1
fi

if [[ $install -eq 1 ]]; then
  if ! command -v brew >/dev/null 2>&1; then
    printf 'Homebrew is required for --install. Install Ollama from https://ollama.com/download/mac instead.\n' >&2
    exit 1
  fi
  if ! command -v ollama >/dev/null 2>&1; then
    brew install ollama
  fi
fi
if ! command -v ollama >/dev/null 2>&1; then
  printf 'Native Ollama is missing. Run: bash ai-service/run-local-gpu.sh --install\n' >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  printf 'Python 3 is required for the upload page.\n' >&2
  exit 1
fi
if lsof -nP -iTCP:"$ollama_port" -sTCP:LISTEN >/dev/null 2>&1; then
  printf 'Port %s is in use. Stop that service before starting this private Ollama instance.\n' "$ollama_port" >&2
  exit 1
fi
if lsof -nP -iTCP:"$web_port" -sTCP:LISTEN >/dev/null 2>&1; then
  printf 'Port %s is in use. Stop that page before starting this one.\n' "$web_port" >&2
  exit 1
fi

export OLLAMA_NO_CLOUD=1
export OLLAMA_HOST=127.0.0.1:"$ollama_port"
export AI_SERVICE_OLLAMA_URL=http://127.0.0.1:"$ollama_port"
export AI_SERVICE_MODEL="$model"

cleanup() {
  if [[ -n $ollama_pid ]]; then
    kill "$ollama_pid" 2>/dev/null || true
    wait "$ollama_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

printf 'Starting native Ollama on %s (cloud features disabled)...\n' "$OLLAMA_HOST"
ollama serve >/dev/null 2>&1 &
ollama_pid=$!
ready=0
for _ in {1..30}; do
  if curl --silent --fail --max-time 1 "$AI_SERVICE_OLLAMA_URL/api/version" >/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$ollama_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [[ $ready -ne 1 ]]; then
  printf 'Native Ollama did not start on %s.\n' "$OLLAMA_HOST" >&2
  exit 1
fi

printf 'Ensuring local model %s is installed...\n' "$model"
ollama pull "$model"
ollama run "$model" "" >/dev/null
processor=$(ollama ps)
printf '%s\n' "$processor"
if ! printf '%s\n' "$processor" | grep -q GPU; then
  printf 'Ollama did not report GPU use. Check Ollama logs and macOS GPU availability.\n' >&2
  exit 1
fi

printf '\nAI service page: http://127.0.0.1:%s\nPress Ctrl-C to stop the page and native Ollama.\n' "$web_port"
python3 "$script_dir/web_server.py" --port "$web_port"
