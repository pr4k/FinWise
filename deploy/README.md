# Container deployment

From the repository root:

```sh
docker compose -f deploy/compose.yaml up --build -d
curl --fail http://127.0.0.1:3000/health/ready
```

Place an HTTPS reverse proxy in front of `127.0.0.1:3000` for browser use. The container uses secure session cookies; direct plain-HTTP authentication is unsupported. For HTTP development, run the native command in `backend/README.md`. CORS remains disabled. The compose service publishes only to host loopback.

The image runs as UID 10001 with a read-only root filesystem, no Linux capabilities, and a named SQLite volume at `/data`. Use one replica per database. The same image serves the static frontend preview and API; the preview still uses sample data. Use `docker compose -f deploy/compose.yaml logs` for startup errors. Do not use `down --volumes` unless deliberately deleting all household data.

The process handles SIGTERM and SIGINT for graceful shutdown. SQLite uses WAL; copying only the live `.sqlite` file is not a consistent backup. Automated backup/restore, multi-architecture image publication, NAS performance testing, and proxy/device acceptance remain pending. These files provide a build/deployment baseline, not a completed NAS release.
