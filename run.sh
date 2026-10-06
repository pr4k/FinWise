#!/bin/sh
# Axum serves web/ and /api/v1 together; no separate frontend server is needed.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"
ENV_FILE=${FINWISE_ENV_FILE:-"$ROOT/.env"}
if [ ! -f "$ENV_FILE" ]; then
    if [ "$ENV_FILE" != "$ROOT/.env" ]; then
        echo "Configuration file does not exist: $ENV_FILE" >&2
        exit 1
    fi
    cp "$ROOT/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
fi
# This is a trusted local shell configuration file, never uploaded input.
set -a
. "$ENV_FILE"
set +a
command -v cargo >/dev/null 2>&1 || { echo "Install Rust and Cargo before running FinWise." >&2; exit 1; }
printf 'Starting FinWise frontend and API at http://%s\n' "${FINWISE_BIND:-127.0.0.1:3000}"
if [ "${FINWISE_RELEASE:-false}" = true ]; then
    exec cargo run --locked --release -p finwise-api
fi
exec cargo run --locked -p finwise-api
