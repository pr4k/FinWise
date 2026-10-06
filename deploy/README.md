# Container deployment

From the repository root:

```sh
docker compose -f deploy/compose.yaml up --build -d
curl --fail http://127.0.0.1:3000/health/ready
```

Compose publishes to host loopback by default. To let a reverse proxy on another machine reach the NAS, create or edit the ignored `.env` file in the repository root and set `FINWISE_PUBLISH_IP` to the NAS's LAN address (for example, `192.168.1.194`). `FINWISE_PUBLISH_PORT` optionally changes the host port from 3000. Run Compose from the repository root so it reads that `.env` file. These settings change only the host port mapping; the container still listens on port 3000. Do not set `FINWISE_INSECURE_LOCAL_COOKIES=true` inside the container. If you previously edited `deploy/compose.yaml` on the NAS to expose the port, move that address into `.env` and remove the local Compose edit before pulling updates; otherwise Git may reject the pull.

Place an HTTPS reverse proxy in front of the published port for browser use. The container uses secure session cookies; direct plain-HTTP authentication is unsupported. For HTTP development, run the native command in `backend/README.md`. CORS remains disabled.

## Updating a shell-managed NAS installation

From the repository root on the NAS:

```sh
git pull --ff-only
sudo docker compose -f deploy/compose.yaml up --build -d
sudo docker compose -f deploy/compose.yaml ps
```

Compose rebuilds the image from the updated source and recreates the service if needed. The named `deploy_finwise-data` volume persists. Check `sudo docker compose -f deploy/compose.yaml logs --tail=100 finwise` if the service does not become healthy. Do not use `down --volumes` unless deliberately deleting all household data. Shell-managed Compose projects do not appear in TrueNAS Apps. Moving management into the Apps UI requires a separate custom-app installation and an image available to TrueNAS; the current repository does not publish one.

The image runs as UID 10001 with a read-only root filesystem, no Linux capabilities, and a named SQLite volume at `/data`. Use one replica per database. The same image serves the static frontend preview and API; the preview still uses sample data. Use `docker compose -f deploy/compose.yaml logs` for startup errors.

The process handles SIGTERM and SIGINT for graceful shutdown. SQLite uses WAL; copying only the live `.sqlite` file is not a consistent backup. Automated backup/restore, multi-architecture image publication, NAS performance testing, and proxy/device acceptance remain pending. These files provide a build/deployment baseline, not a completed NAS release.
