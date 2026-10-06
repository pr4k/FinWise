# Container deployment

From the repository root:

```sh
docker compose -f deploy/compose.yaml up --build -d
curl --fail http://127.0.0.1:3000/health/ready
```

Compose publishes to host loopback by default. To let a reverse proxy on another machine reach the NAS, create or edit the ignored `.env` file in the repository root and set `FINWISE_PUBLISH_IP` to the NAS's LAN address (for example, `192.168.1.194`). `FINWISE_PUBLISH_PORT` optionally changes the host port from 3000. Pass `--env-file .env` explicitly when running Compose from the repository root: with the Compose file under `deploy/`, automatic `.env` discovery may look there instead. These settings change only the host port mapping; the container still listens on port 3000. Do not set `FINWISE_INSECURE_LOCAL_COOKIES=true` inside the container. If you previously edited `deploy/compose.yaml` on the NAS to expose the port, move that address into `.env` and remove the local Compose edit before pulling updates; otherwise Git may reject the pull.

To apply the NAS address now:

```sh
sudo docker compose --env-file .env -f deploy/compose.yaml up -d
sudo docker compose --env-file .env -f deploy/compose.yaml ps
```

Place an HTTPS reverse proxy in front of the published port for browser use. The container uses secure session cookies; direct plain-HTTP authentication is unsupported. Opening `http://<NAS-IP>:3000` through a Tailscale subnet route is still an HTTP page to the browser, so household setup and sign-in require an HTTPS URL. For HTTP development, run the native command in `backend/README.md`. CORS remains disabled.

## Updating a shell-managed NAS installation

After new commits have been pushed to the public repository, run this single command from the repository root on the NAS:

```sh
./deploy/update.sh
```

The NAS checkout must be on `main` with no local changes. On the NAS, make the public repository's Git remote HTTPS once so the script can pull without a GitHub SSH key:

```sh
git -C "$HOME/FinWise" remote set-url origin https://github.com/pr4k/FinWise.git
```

The script pulls `origin/main` and builds while the old container runs. It then stops the service to archive the entire `/data` volume, including SQLite WAL files, to the ignored `backups/` directory before starting the new image. Set `FINWISE_BACKUP_DIR` if backups belong on another dataset. It refuses to update if it cannot find the expected volume or verify the backup, and restarts the existing container if the backup fails. It reports a startup failure and keeps the backup if the new container does not become healthy. The named `deploy_finwise-data` volume is never removed. Store an additional copy of backups off the NAS for hardware failure protection. Do not use `down --volumes` unless deliberately deleting all household data.

Shell-managed Compose projects do not appear in TrueNAS Apps. Moving management into the Apps UI requires a separate custom-app installation and an image available to TrueNAS; the current repository does not publish one.

The image runs as UID 10001 with a read-only root filesystem, no Linux capabilities, and a named SQLite volume at `/data`. Use one replica per database. The same image serves the static frontend preview and API; the preview still uses sample data. Use `docker compose -f deploy/compose.yaml logs` for startup errors.

The process handles SIGTERM and SIGINT for graceful shutdown. SQLite uses WAL; copying only the live `.sqlite` file is not a consistent backup. Automated backup/restore, multi-architecture image publication, NAS performance testing, and proxy/device acceptance remain pending. These files provide a build/deployment baseline, not a completed NAS release.
