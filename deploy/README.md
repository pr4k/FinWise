# Container deployment

From the repository root on TrueNAS:

```sh
test -f .env || cp .env.example .env
sudo docker compose --env-file .env -f deploy/compose.yaml up --build -d
sudo docker compose --env-file .env -f deploy/compose.yaml ps
sudo docker compose --env-file .env -f deploy/compose.yaml exec finwise curl --fail http://127.0.0.1:3000/health/ready
```

Compose publishes `0.0.0.0:3000` and allows HTTP sign-in by default. Open `http://<TrueNAS-Tailscale-IP>:3000` when Tailscale runs on TrueNAS. If you use a Tailscale subnet router, open `http://<TrueNAS-LAN-IP>:3000` through that route. Use the IP address with `http://`. Keep port 3000 off the public internet.

If an existing account cannot sign in, an administrator with NAS shell access can reset its password after deploying a build that includes the recovery command. From the repository root, run `sudo -v` first, then:

```sh
read -rsp 'New FinWise password: ' finwise_new_password; printf '\n'
printf '%s\n' "$finwise_new_password" | sudo -n docker compose --env-file .env -f deploy/compose.yaml exec -T finwise finwise-api --reset-password 'ACCOUNT_EMAIL'
unset finwise_new_password
```

Replace `ACCOUNT_EMAIL` with the registered email. The password must be at least 12 bytes. The command updates that account's password, revokes its sessions, and clears its login-attempt limit. It records a console-reset audit event and does not print the password. The audit schema does not store which NAS administrator ran the command.

To limit the published port to one TrueNAS interface, set `FINWISE_PUBLISH_IP` in the repository root `.env` and rerun the `up` command. Use the TrueNAS Tailscale IP when Tailscale runs on TrueNAS, or its LAN IP for a subnet route:

```sh
FINWISE_PUBLISH_IP=100.x.y.z
```

`FINWISE_PUBLISH_PORT` optionally changes the host port from 3000. Pass `--env-file .env` explicitly so Compose reads the repository root configuration. Check an existing `.env` for `FINWISE_PUBLISH_IP`, `FINWISE_PUBLISH_PORT`, or `FINWISE_ALLOW_INSECURE_HTTP` values that override these defaults. `FINWISE_PUBLISH_IP` changes only the host port mapping; the container still listens on port 3000. Compose passes `FINWISE_ALLOW_INSECURE_HTTP=true` to the container by default, allowing session cookies over direct HTTP. `FINWISE_INSECURE_LOCAL_COOKIES` in `.env` is for `./run.sh` and is not passed to the container. If you previously edited `deploy/compose.yaml` on the NAS, move those settings into `.env` and remove the local Compose edit before pulling updates; otherwise Git may reject the pull.

HTTP traffic on the LAN segment between a separate Tailscale subnet router and TrueNAS is unencrypted. Browsers will not mark the page as secure. If you later put an HTTPS reverse proxy in front, set `FINWISE_ALLOW_INSECURE_HTTP=false`. For local HTTP development, run the native command in `backend/README.md`. CORS remains disabled.

If the page stays at **Connecting to FinWise…**, reload it without the browser cache, then check the API from the NAS:

```sh
sudo docker compose --env-file .env -f deploy/compose.yaml exec finwise curl -i http://127.0.0.1:3000/api/v1/auth/bootstrap-status
sudo docker compose --env-file .env -f deploy/compose.yaml exec finwise printenv FINWISE_ALLOW_INSECURE_HTTP
sudo docker compose --env-file .env -f deploy/compose.yaml port finwise 3000
```

The API should return JSON with `"requires_https":false`. The `port` command should show the NAS address and port 3000. Test `http://<TrueNAS-Tailscale-IP>:3000/health/ready` from a Tailscale device. If the local check works but the remote check fails, verify the TrueNAS firewall and Tailscale routing/ACLs. If the local check fails, check `sudo docker compose --env-file .env -f deploy/compose.yaml logs --tail=100 finwise`. If the API works but `/` returns 404 and the container is unhealthy, check that `/app/web/index.html` is readable by the `finwise` user inside the container. The image sets ownership during build; rebuild it after pulling this change. If the API responds but the page still does not advance, reload without the browser cache and check the browser developer console.

## Updating a shell-managed NAS installation

After new commits have been pushed to the public repository, run this single command from the repository root on the NAS:

```sh
bash deploy/update.sh
```

The NAS checkout must be on `main` with no local changes. On the NAS, make the public repository's Git remote HTTPS once so the script can pull without a GitHub SSH key:

```sh
git -C "$HOME/FinWise" remote set-url origin https://github.com/pr4k/FinWise.git
```

The script pulls `origin/main` and builds while the old container runs. It then stops the service to archive the entire `/data` volume, including SQLite WAL files, to the ignored `backups/` directory before starting the new image. Set `FINWISE_BACKUP_DIR` if backups belong on another dataset. It refuses to update if it cannot find the expected volume or verify the backup, and restarts the existing container if the backup fails. It reports a startup failure and keeps the backup if the new container does not become healthy. The named `deploy_finwise-data` volume is never removed. Store an additional copy of backups off the NAS for hardware failure protection. Do not use `down --volumes` unless deliberately deleting all household data.

Shell-managed Compose projects do not appear in TrueNAS Apps. Moving management into the Apps UI requires a separate custom-app installation and an image available to TrueNAS; the current repository does not publish one.

The image runs as UID 10001 with a read-only root filesystem, no Linux capabilities, and a named SQLite volume at `/data`. Use one replica per database. The same image serves the static frontend preview and API; the preview still uses sample data. Use `docker compose -f deploy/compose.yaml logs` for startup errors.

The process handles SIGTERM and SIGINT for graceful shutdown. SQLite uses WAL; copying only the live `.sqlite` file is not a consistent backup. Automated backup/restore, multi-architecture image publication, NAS performance testing, and proxy/device acceptance remain pending. These files provide a build/deployment baseline, not a completed NAS release.
