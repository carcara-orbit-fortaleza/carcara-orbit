**English** · [Português](DEPLOY.pt-BR.md)

# VPS deploy and CI/CD

The flow follows the [Baseware](https://github.com/platusforge/baseware) pattern:
GitHub Actions validates the monorepo, copies the files to the VPS over SCP,
writes `.env` from the secrets and variables, brings up the production Compose
stack and removes `.env`.

This project **does not run Traefik**. The Traefik instance already serving
`80/443` on the VPS is the edge: the `web` container joins its network and
receives the subdomain labels. See [Reverse proxy](#reverse-proxy-vps-traefik).

## VPS prerequisites

- Docker Engine + Compose v2.
- Traefik already running on `80/443`, with ACME/Let's Encrypt configured.
- `APP_HOST` DNS pointing to the VPS IP.
- A user with Docker access (or `sudo` configured for the deploy user).
- Deploy directory: `~/dev/carcara-orbit`.

## Repository variables

Create them in `Settings → Secrets and variables → Actions → Variables`:

| Variable | Default | Use |
| --- | --- | --- |
| `DEPLOY_ENABLED` | — | `true` enables the `deploy` job; without it only `verify` runs |
| `TRAEFIK_NETWORK` | `traefik-proxy` | VPS Traefik Docker network |
| `TRAEFIK_ENTRYPOINT` | `websecure` | Traefik TLS entrypoint |
| `TRAEFIK_CERT_RESOLVER` | `le` | Traefik ACME certresolver |

Without `DEPLOY_ENABLED=true`, the `deploy` job is skipped and only `verify`
runs. This prevents accidental deploys before the secrets are configured. To
disable deploys, remove the variable.

## Required secrets

| Secret | Example / note |
| --- | --- |
| `HOST` | VPS IP or hostname |
| `USERNAME` | SSH user |
| `PRIVATE_KEY` | SSH private key (full contents) |
| `SSH_PORT` | `22` |
| `DB_USER` | `carcara` |
| `DB_PASSWORD` | strong password; required |
| `DB_NAME` | `carcara` |
| `APP_HOST` | public subdomain, e.g. `orbit.example.org` |

> `ADMIN_EMAIL` is no longer used by this project: the certificate is issued by
> the Traefik instance already running on the VPS.

### Optional secrets

| Secret | Default | Use |
| --- | --- | --- |
| `DB_POOL_MAX` | `10` | API pool connections |
| `API_PORT` | `3000` | internal API port |
| `FIRMS_MAP_KEY` | empty | NASA FIRMS NRT/backfill and current-year job |
| `DATA_SOURCE` | `mock` | `mock` or `real` |
| `ADMIN_TOKEN` | empty | protects `/api/mode`, `/api/ingestion/run`, `/api/nrt/refresh` |
| `GEMINI_API_KEY` | empty | `POST /api/explain` key; without it the endpoint returns 503 `explain_disabled` |
| `EXPLAIN_ENABLED` | `false` | must be exactly `true` (together with the key) to enable the endpoint |
| `EXPLAIN_MODEL` | `gemini-3.5-flash-lite` | model used for explanations |
| `EXPLAIN_DAILY_TOKEN_BUDGET` | `200000` | daily token cap (in memory, per instance, resets at 00:00 UTC) |
| `EXPLAIN_DAILY_TOKEN_BUDGET_PER_IP` | 1/10 of the global (`20000`) | daily token cap per IP (in memory, bounded map that drops the least recent IP, resets at 00:00 UTC) |
| `EXPLAIN_TRUST_PROXY` | `1` in `docker-compose.prod.yml`; off elsewhere | trusted proxy hops for the rate-limit and per-IP cap (fixed Traefik -> `web` nginx -> api topology). Without it every client shares the nginx IP key and one client can block the others; with `EXPLAIN_ENABLED=true` and this off, boot logs a WARN |
| `NRT_ENABLED` | `false` | NRT refresh schedule |
| `NRT_INTERVAL_MINUTES` | `180` | NRT interval |
| `NRT_DAYS` | `2` | NRT window (max 5) |
| `NRT_REGIONS` | empty | NRT regions |
| `FIRMS_SOURCES` | MODIS/VIIRS NRT | NRT sources |
| `FIRMS_COUNTRY` | `Brazil` | historical bootstrap country |
| `REGIONS_FILE` | repo regions | custom region GeoJSON |
| `GLOBAL_GRID_DEGREES` | `10` | world ingestion grid (5–60) |
| `GLOBAL_NRT_TILE_DEGREES` | `30` | global NRT tiles |
| `GLOBAL_START_YEAR` | `2000` | global load start |
| `GLOBAL_END_YEAR` | previous year | global load end |
| `GLOBAL_MAX_FILES` | unlimited | file limit per run |
| `MAX_MAP_POINTS` | `2000` | map GeoJSON limit |
| `MAX_EXPORT_ROWS` | `50000` | export limit |

> `DATABASE_URL` does not need to be configured: Compose passes `DB_*` and the
> API builds the URL with percent-encoded credentials.

> `API_PORT` is the **internal** Compose network port. In production it is not
> published on the host, so it does not conflict with any other service already
> using `3000` on the VPS. Only development mode
> (`docker-compose.override.yml`) publishes `API_PORT`, `WEB_PORT` and `DB_PORT`
> on the host.

## Reverse proxy (VPS Traefik)

`docker-compose.prod.yml` does not publish `80/443` and does not create Traefik.
The `web` service joins the existing Traefik network (`TRAEFIK_NETWORK`) and
receives these labels:

- `traefik.enable=true`
- `traefik.docker.network=$TRAEFIK_NETWORK`
- `traefik.http.routers.carcara-orbit.rule=Host($APP_HOST)`
- `traefik.http.routers.carcara-orbit.entrypoints=$TRAEFIK_ENTRYPOINT`
- `traefik.http.routers.carcara-orbit.tls.certresolver=$TRAEFIK_CERT_RESOLVER`
- `traefik.http.services.carcara-orbit.loadbalancer.server.port=80`

Discover the values on the VPS:

```bash
TRAEFIK=$(docker ps --format '{{.Names}}' | grep -i traefik | head -n1)

# network mode: "host" requires the fallback below; "bridge" (default) uses the network
docker inspect "$TRAEFIK" --format '{{.HostConfig.NetworkMode}}'

# Traefik network(s) — use the exact name in TRAEFIK_NETWORK
docker inspect "$TRAEFIK" \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}'

# entrypoints and certresolver
docker inspect "$TRAEFIK" --format '{{json .Args}}' | tr ',' '\n' \
  | grep -E 'entrypoints|certresolver|providers.docker'
```

- **Network:** the exact name in `docker network ls` (e.g. `traefik`, `proxy`,
  `traefik_default`). That is `TRAEFIK_NETWORK`. Ignore `bridge`/`host`: use the
  user-defined network that Traefik shares with the services.
- **Entrypoint:** the one pointing to `:443` (usually `websecure`).
- **Certresolver:** the `<name>` from
  `--certificatesresolvers.<name>.acme...` (e.g. `le`, `letsencrypt`).

> If Traefik uses a configuration file instead of flags, the same names are in
> the container's `traefik.yml`/`traefik.toml` or in the dashboard.

A typical containerized Traefik uses
`providers.docker.exposedbydefault=false`, which matches the labels above. The
API and Postgres have `traefik.enable=false` so they are never routed, even if
Traefik exposes containers by default.

If the network does not exist yet, create it and connect Traefik:

```bash
docker network create traefik-proxy
docker network connect traefik-proxy "$TRAEFIK"
```

> Traefik in `network_mode: host` cannot reach containers by name. In that case,
> publish `web` on `127.0.0.1:8080` (override with
> `ports: ["127.0.0.1:8080:80"]`) and create a file-provider router pointing to
> `http://127.0.0.1:8080`.

After deploying, validate the public path:

```bash
curl -I "https://$APP_HOST"
curl -fsS "https://$APP_HOST/api/health"
```

### Proxy troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `network ... declared as external, but could not be found` | wrong `TRAEFIK_NETWORK`; fix the variable or create the network |
| Traefik 404 | `web` outside the network, missing `traefik.enable=true`, or Traefik's Docker provider disabled |
| 404 and `docker inspect <web> --format '{{.State.Health.Status}}'` shows `unhealthy` | Traefik ignores unhealthy containers; fix the healthcheck (use `127.0.0.1`, not `localhost`) |
| 404 and `web` is missing from the Traefik dashboard | Traefik's `providers.docker.constraints` excludes the container |
| `certificate resolver ... does not exist` / invalid TLS | `TRAEFIK_CERT_RESOLVER` does not match Traefik's ACME setup |
| 502 Bad Gateway | `web` unhealthy or `traefik.http.services...server.port` is not `80` |

## What the workflow does

1. **verify** (push/PR to `main`):
   - installs `api/` and `web/` dependencies;
   - runs lint, build and unit tests;
   - runs the pipeline tests and the e2e suite;
   - starts a Postgres service, applies migrations and tests `/api/health`;
   - validates both Compose files;
   - builds the API and web Docker images.
2. **deploy** (push to `main`, if `DEPLOY_ENABLED=true`):
   - copies the repository to `~/dev/carcara-orbit`;
   - cleans untracked files left by previous copies (SCP does not delete files
     removed from the repo, and stale files under `web/src` break `tsc -b`);
   - writes `.env` from the secrets and `TRAEFIK_*` variables;
   - runs `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --force-recreate --remove-orphans` (without publishing `80/443`);
   - the API entrypoint applies pending migrations on boot;
   - waits for `/api/health` to be `ok` with Postgres connected (with retries);
   - removes `.env` at the end (even on error).

## Manual deploy

```bash
cd ~/dev/carcara-orbit
cp .env.example .env
# edit DB_*, APP_HOST, TRAEFIK_* and the other variables
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env up -d --build --force-recreate --remove-orphans
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env exec -T api node scripts/migrate.mjs
rm .env
```

## Migrations

Migrations live in `api/db/migrations` and are tracked by `schema_migrations`.
The API entrypoint applies pending migrations on every boot:

```bash
docker compose exec api npm run db:migrate
```

To create a migration, add a new numbered `.sql` file. Do not edit a migration
that has already been applied in production.

## Database

- `db`: PostgreSQL 16 with the `postgres_data` volume.
- `db-backup`: daily backup with 7-day, 4-week and 6-month retention in the
  `postgres_backups` volume.
- Port `5432` is published only in the development Compose; in production the
  database is restricted to the internal network.

### Backup and restore

```bash
# list backups
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec db-backup ls -l /backups

# restore (maintenance window)
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
docker volume rm carcara-orbit_postgres_data
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d db
gunzip -c backups/latest.sql.gz | docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db psql -U "$DB_USER" -d "$DB_NAME"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

> The volume name is prefixed by the Compose project (`carcara-orbit_`). Check
> with `docker volume ls` before removing it.

## Analytical data on the VPS

Postgres stores the operational history (`operation_runs`) and service health.
The series shown on the web comes from the **global aggregate**, persisted in the
`api_data` volume:

- `data/db/aggregates.sqlite` — cell × year × month × sensor aggregate,
  calibration factors and recent hotspot sample (dashboard path);
- `data/db/global.sqlite` — row-level hotspots and clusters (legacy track);
- `data/runtime/global-*.json` — grid, calibration, status and checkpoints;
- `data/raw/global/` — original FIRMS CSVs, including the `current/` overlay.

The dashboard consumes `/api/global/aggregates` (every cell) and
`/api/global/hotspots` (recent sample). The current year comes from FIRMS
availability, and the current-year overlay can be fetched through the Area API.
The Brazil dataset (`data/db/firms.sqlite` + `data/real/`) and the
`/api/hotspots`, `/api/regions` and `/api/calendar` endpoints remain available
for compatibility; `DATA_SOURCE` only controls that legacy track.

> The `db-backup` daily backup only covers Postgres. `aggregates.sqlite` is
> derived from the CSVs and can be rebuilt; to preserve it, copy the `api_data`
> volume or keep the CSVs.

### Global historical download

The full load has **10,095 files (~43.5 GB)** and is resumable. Validate the plan
and a pilot first:

```bash
cd ~/dev/carcara-orbit

# plan, downloads nothing
docker exec carcara-orbit-api-1 npm run global -- \
  --dry-run --countries all --grid 10 --json

# 20-file pilot
docker exec carcara-orbit-api-1 npm run global -- \
  --countries all --grid 10 --max-files 20
```

For the full download, run it in a separate container: an API deploy recreates
the container and would kill the process. The container below shares the volume
and survives deploys:

```bash
docker run -d --name carcara-global-ingest \
  -v carcara-orbit_api_data:/app/data \
  carcara-orbit-api:latest \
  sh -c 'npm run global -- --countries all --grid 10 \
    > /app/data/runtime/global-full.log 2>&1'
```

> The row-level import in `npm run global` is legacy and not required by the
> dashboard; the current path is to download the CSVs and run the DuckDB
> aggregate.

Follow it:

```bash
docker exec carcara-global-ingest tail -f /app/data/runtime/global-full.log
curl https://$APP_HOST/api/global/status
```

### Current year (FIRMS API)

The yearly country archive only contains closed years. To populate the open year,
run the FIRMS Area API job. It reads the availability CSV, splits each sensor
family between standard processing and NRT, and writes 5-day chunks into
`data/raw/global/current/<source>/`:

```bash
cd ~/dev/carcara-orbit

# list the ranges first
docker run --rm --ulimit nofile=65536:65536 \
  -v carcara-orbit_api_data:/data \
  -v "$PWD/api/scripts:/scripts:ro" \
  -e FIRMS_MAP_KEY="$FIRMS_MAP_KEY" \
  python:3.12-slim \
  python /scripts/fetch_current_year.py --year 2026 --dry-run

# download the year (resumable; existing chunks are skipped)
docker run --rm --name carcara-fetch-current \
  --ulimit nofile=65536:65536 \
  -v carcara-orbit_api_data:/data \
  -v "$PWD/api/scripts:/scripts:ro" \
  -e FIRMS_MAP_KEY="$FIRMS_MAP_KEY" \
  python:3.12-slim \
  python /scripts/fetch_current_year.py --year 2026 --delay 0.8
```

`--max-chunks 4` makes a quick pilot. After the fetch, rerun the aggregate; it
reads the overlay automatically and 2026 counts stop being zero. Remove the
`current/` directory once the yearly archive for that year is available to avoid
double counting.

The FIRMS Area API limit is 5000 transactions per 10-minute interval; a world
5-day request counts as several transactions. The job paces requests, waits 10
minutes when the limit is hit and skips chunks already on disk when resumed.

### Global aggregate (DuckDB)

After the download, build the compact aggregate in an isolated container (it does
not interrupt the API and survives deploys):

```bash
cd ~/dev/carcara-orbit

docker run --rm --name carcara-global-aggregate \
  --ulimit nofile=65536:65536 \
  -v carcara-orbit_api_data:/data \
  -v "$PWD/api/scripts:/scripts:ro" \
  python:3.12-slim \
  sh -c 'pip install --quiet duckdb && python /scripts/global_aggregate.py \
    --raw /data/raw/global \
    --regions /data/runtime/global-regions.json \
    --out /data/db/aggregates.sqlite \
    --tmp /data/db/duckdb-tmp \
    --threads 4 --memory-limit 6GB'
```

- `--max-files 60` makes a quick pilot; without it, the job reads the ~43 GB.
- `--points-per-cell` (default 100) controls the sample used by the map.
- The job streams the CSVs and atomically replaces `aggregates.sqlite` at the
  end, so the API can keep serving the previous file during the rebuild.

Check it:

```bash
curl https://$APP_HOST/api/global/aggregates | head -c 300
docker exec carcara-orbit-api-1 ls -lh /app/data/db/aggregates.sqlite
```

The legacy ingestion track updates `data/db/global.sqlite`,
`data/runtime/global-download.json` and `data/runtime/global-ingestion.json`. The
PostGIS and scale path is in [`REQUISITOS.md`](./REQUISITOS.md).

> `npm run bootstrap` remains available for the Brazil track (legacy endpoints),
> but it is no longer required by the web app.

## Rollback

The deploy does not tag images with versions. To go back one release:

```bash
cd ~/dev/carcara-orbit
git log --oneline -5
git checkout <previous-commit>
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Because the workflow copies the working tree, a new push to `main` overwrites the
directory again; roll back with a revert commit, not only on the server.
