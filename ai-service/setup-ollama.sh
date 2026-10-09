#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
model=${1:-qwen2.5:3b}
export AI_SERVICE_MODEL="$model"

if ! docker info >/dev/null 2>&1; then
  printf 'Docker daemon is unavailable. Start or repair Docker Desktop, then retry.\n' >&2
  exit 1
fi

docker compose -f "$script_dir/compose.yaml" up -d --wait ollama
docker compose -f "$script_dir/compose.yaml" exec -T ollama ollama pull "$model"
docker compose -f "$script_dir/compose.yaml" exec -T ollama ollama list
docker compose -f "$script_dir/compose.yaml" up -d --build --wait web

printf '\nAI service page: http://127.0.0.1:8765 (model %s)\n' "$model"
