# Deploy OBTV AI Video Studio on Ubuntu

This deployment starts three containers from one Compose project:

- `web` — an unprivileged Node static server serving the compiled React app.
- `api` — Express API, versioned database migrations, seed initialization, and
  local media storage.
- `db` — PostgreSQL 16.

ComfyUI remains external. Configure and test ComfyUI workers from the OBTV
server dashboard after deployment.

Nginx Proxy Manager (NPM) is the public reverse proxy. It is intentionally not
included in this Compose project, and there is no local nginx configuration to
maintain.

## Prerequisites

- Ubuntu 22.04+ with Docker Engine and Docker Compose v2 installed.
- A domain and TLS reverse proxy if the app is public. TLS, DNS, firewall rules,
  and server provisioning are intentionally outside this project.
- Network access from the API container to each permitted ComfyUI worker.

The Compose project binds the web server to `127.0.0.1:${WEB_PORT}` (8080 by
default) and the API to `127.0.0.1:${API_PORT}` (5000 by default). In NPM,
create a Proxy Host for the public domain that forwards `/` to the web port,
then add a Custom Location for `/api` (including `/api/media/...`) forwarding
to the API port. Keep both routes on the same public domain so the browser
uses same-origin relative API requests.

If NPM runs in Docker rather than directly on Ubuntu, use the host gateway or
the Docker network address that NPM can reach instead of `127.0.0.1`. The
Compose ports are intentionally loopback-only and should not be exposed
directly to the internet.

The API and web containers run without root privileges. The named media volume
is initialized with ownership for the API user; if you replace it with a host
bind mount, make the host directory writable by UID/GID `10001`.

## First install

1. Copy the repository to the Ubuntu host and change to its root.
2. Create the runtime environment file:

   ```sh
   cp deployment/.env.example .env
   chmod 600 .env
   ```

3. Edit `.env`. Set a unique, long, URL-safe `POSTGRES_PASSWORD`, choose
   `WEB_PORT` and `API_PORT` if the defaults are already in use, and set
   `COMFY_ALLOWED_HOSTS` to the hostnames or public IPs of the ComfyUI workers.
   Do not put `http://`, `https://`, `ws://`, ports, or paths in the allowlist.
   Set each matching `OBTV_SEED_*_API_URL` and
   `OBTV_SEED_*_WEBSOCKET_URL` pair to seed that external worker.
4. Build and start:

   ```sh
   docker compose up -d --build
   ```

5. Confirm startup and API health:

   ```sh
   docker compose ps
   docker compose logs -f api
   curl -fsS http://127.0.0.1:${API_PORT:-5000}/api/healthz
   curl -fsS http://127.0.0.1:${WEB_PORT:-8080}/
   ```

On a fresh database, the API applies the committed Drizzle migrations before it
opens its HTTP port. It then seeds the complete studio workflow catalog
idempotently; existing user-managed records are not overwritten.

### MiniMax H3 workflow bootstrap

The deployment seed includes these active `r2v` variants:

- **Image reference, A100** — requires `minimax-h3` and `a100` tags and uses
  `qwen3vl_32b_minimax_h3_int8_convrot.safetensors`.
- **Image reference, Blackwell** — requires `minimax-h3` and `blackwell` tags and uses
  `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`.
- **Video/audio reference, A100** — requires `minimax-h3` and `a100` tags,
  loads the uploaded video with `LoadVideo`, and extracts its video/audio
  components.
- **Video/audio reference, Blackwell** — requires `minimax-h3` and `blackwell`
  tags, loads the uploaded video with `LoadVideo`, and extracts its video/audio
  components.

The seed also creates the inactive `MiniMax H3 FL2VA` catalog placeholder for a
future first/last-frame workflow. Video/audio reference variants do not require
cast or environment assets; the uploaded video is their reference.

Set the endpoint pairs in `.env` before the first `docker compose up -d --build`
to create the corresponding worker records. The seed only inserts missing
worker names and workflow names, so it never replaces URLs, tags, model choices,
or API JSON that you have already edited in an existing deployment.
The sole upgrade exception is the original, inactive, API-less MiniMax H3
placeholder shipped by earlier OBTV versions; its exact unedited fingerprint is
upgraded to the Blackwell variant so prior deployments receive the working seed.
An exact stale video-reference seed containing the old disconnected
`reference-character-1.png` and `reference-character-2.png` loaders is also
upgraded to the cleaned `LoadVideo`/`GetVideoComponents` graph.

`docker compose build` produces images but cannot seed PostgreSQL by itself;
the seed runs when the API container starts during `docker compose up -d`.
The configured worker hosts must be in `COMFY_ALLOWED_HOSTS`, and the matching
model files and custom nodes must already be installed on those external
ComfyUI workers.

## Operations

### Logs and lifecycle

```sh
docker compose logs -f web api db
docker compose restart api
docker compose down              # keeps database and media volumes
docker compose up -d
```

`docker compose down -v` deletes the database and uploaded/generated media.
Do not use it for a normal restart or upgrade.

### Upgrade

1. Back up PostgreSQL and media first.
2. Fetch the new source revision.
3. Rebuild and replace services:

   ```sh
   docker compose up -d --build
   ```

The API applies only committed, versioned migrations. It does not use
`drizzle-kit push --force`; do not run that destructive command in production.
If a migration fails, the API stays unavailable and Compose restarts it, leaving
the previous data intact. Review the migration error and restore from backup if
necessary before retrying.

### Back up and restore

Create a database dump plus a tarball of the persistent media volume:

```sh
mkdir -p backups
docker compose exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "backups/obtv-$(date +%F).sql.gz"
docker compose exec -T api tar czf - -C /var/lib/obtv-media . \
  > "backups/obtv-media-$(date +%F).tar.gz"
```

Run these commands in a shell that has loaded `.env` (`set -a; . ./.env; set +a`)
or replace the environment variables explicitly. Test restores on a separate
server before relying on a backup:

```sh
gunzip -c backups/obtv-YYYY-MM-DD.sql.gz \
  | docker compose exec -T db psql -U "$POSTGRES_USER" "$POSTGRES_DB"
```

### Troubleshooting

- **`api` keeps restarting:** `docker compose logs api`. Confirm PostgreSQL is
  healthy and the migration error is resolved. Never bypass a migration with
  `push-force`.
- **Browser gets a 502 or UI but no data:** inspect `docker compose ps` and
  `docker compose logs web api`. Confirm NPM's Proxy Host forwards `/` to the
  web port and its `/api` Custom Location forwards to the API port.
- **Uploads or generated videos disappear:** verify the `obtv_media_data`
  volume exists with `docker volume ls`. Do not use `down -v`.
- **ComfyUI tests fail:** verify outbound network access from the Ubuntu host,
  ensure the worker hostname/IP is in `COMFY_ALLOWED_HOSTS`, and configure the
  worker URL from the dashboard. ComfyUI is not part of this Compose project.
- **A separate frontend needs API access:** set `CORS_ORIGIN` to that exact
  browser origin. Leave it blank when NPM serves the UI and API on one domain.

## Local validation

```sh
pnpm run typecheck
pnpm run build
docker compose --env-file deployment/.env.example config
docker compose build
```

The last two commands require a working Docker daemon. A live render also needs
an externally reachable, allowlisted ComfyUI worker and an imported, active
workflow.