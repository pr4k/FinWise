#!/usr/bin/env bash
# Run on the NAS to pull main, build, back up the stopped SQLite volume, and
# replace the container. Keep the workflow in one function so Bash parses it
# before git pull can update this file on disk.
set -Eeuo pipefail
umask 077

main() {
repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

if [[ ! -f .env ]]; then
    echo "Missing $repo_root/.env (set FINWISE_PUBLISH_IP there)." >&2
    exit 1
fi

if [[ $(git branch --show-current) != main ]]; then
    echo "The NAS checkout must be on the main branch." >&2
    exit 1
fi
if [[ -n $(git status --porcelain) ]]; then
    echo "The NAS checkout has local changes; refusing to pull over them." >&2
    exit 1
fi

echo "Pulling the latest commit from origin/main..."
git pull --ff-only origin main

compose=(sudo docker compose --env-file .env -f deploy/compose.yaml)
container_id=$("${compose[@]}" ps -q finwise)
if [[ -z "$container_id" ]]; then
    echo "FinWise is not running in this Compose project; refusing to update." >&2
    exit 1
fi

volume_name=$(sudo docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container_id")
if [[ "$volume_name" != deploy_finwise-data ]]; then
    echo "Expected deploy_finwise-data at /data, found '$volume_name'; refusing to update." >&2
    exit 1
fi
volume_path=$(sudo docker volume inspect --format '{{.Mountpoint}}' "$volume_name")
if [[ -z "$volume_path" ]]; then
    echo "Could not locate Docker volume $volume_name." >&2
    exit 1
fi

backup_dir=${FINWISE_BACKUP_DIR:-"$repo_root/backups"}
mkdir -p -- "$backup_dir"
chmod 700 "$backup_dir"

echo "Building the new FinWise image while the current service stays online..."
"${compose[@]}" build finwise

echo "Stopping FinWise for a consistent SQLite backup..."
"${compose[@]}" stop finwise
restart_old=true
restart_if_needed() {
    if [[ "$restart_old" == true ]]; then
        echo "Backup did not complete; restarting the existing container..." >&2
        "${compose[@]}" start finwise || true
    fi
}
trap restart_if_needed EXIT

backup_file=$(mktemp "$backup_dir/finwise-$(date -u +%Y%m%dT%H%M%SZ).tar.XXXXXX")
if ! sudo test -f "$volume_path/finwise.sqlite"; then
    echo "The data volume has no finwise.sqlite; refusing to replace the container." >&2
    rm -f -- "$backup_file"
    exit 1
fi
if ! sudo tar -C "$volume_path" -cf - . > "$backup_file"; then
    rm -f -- "$backup_file"
    exit 1
fi
if ! tar -tf "$backup_file" | grep -Eq '(^|/)finwise\.sqlite$'; then
    echo "Backup archive does not contain finwise.sqlite; refusing to update." >&2
    rm -f -- "$backup_file"
    exit 1
fi
echo "Backup saved: $backup_file"

# From this point Compose may replace the old container. Keep the backup and
# report any startup failure instead of trying to run an old image on a
# potentially migrated database.
restart_old=false
trap - EXIT
"${compose[@]}" up --no-build -d finwise

for ((attempt = 0; attempt < 45; attempt++)); do
    container_id=$("${compose[@]}" ps -q finwise)
    if [[ -n "$container_id" ]]; then
        health=$(sudo docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
        if [[ "$health" == healthy ]]; then
            echo "FinWise is healthy. Data volume: $volume_name"
            "${compose[@]}" ps finwise
            exit 0
        fi
        if [[ "$health" == unhealthy || "$health" == exited ]]; then
            break
        fi
    fi
    sleep 2
done

echo "FinWise did not become healthy. Backup: $backup_file" >&2
if [[ -n "$container_id" ]]; then
    sudo docker inspect --format '{{range .State.Health.Log}}{{println .ExitCode .Output}}{{end}}' "$container_id" >&2 || true
fi
"${compose[@]}" logs --tail=100 finwise >&2
exit 1
}

main "$@"
