[English](README.md) · **Português**

# Carcará Orbit

Monorepo do Carcará Orbit: painel e API de monitoramento de focos de calor.
A web atual usa dados e regiões do Brasil; a API também oferece uma trilha de
ingestão e consulta global (ver [`docs/GLOBAL.pt-BR.md`](./docs/GLOBAL.pt-BR.md) e
[`docs/REQUISITOS.pt-BR.md`](./docs/REQUISITOS.pt-BR.md)).

| Pasta | Stack | Descrição |
| --- | --- | --- |
| [`api/`](./api) | NestJS 12 · TypeScript · Node 24 | API de focos, calendário, regiões, exportação e pipeline FIRMS |
| [`web/`](./web) | React 19 · Vite 7 · Tailwind 4 | Site público e painel (`/dashboard`) |

Os códigos originais viviam nos repositórios
[carcara-api](https://github.com/carcara-orbit-fortaleza/carcara-api) e
[carcara-web](https://github.com/carcara-orbit-fortaleza/carcara-web);
este monorepo passa a ser a fonte única de verdade.

A infraestrutura segue o padrão do [Baseware](https://github.com/platusforge/baseware):
três arquivos de Compose (base, override de desenvolvimento e override de produção),
Postgres 16 em container com backup diário e Dockerfiles multi-stage. Em produção,
o nginx serve a SPA e faz proxy de `/api`; o Traefik que já roda na VPS termina o
TLS e roteia o subdomínio para o `web`. O CI/CD faz verificação, build das imagens
e deploy por SSH na VPS.

## Como os dois se conectam

- **Desenvolvimento:** o navegador chama a API em `http://localhost:3000/api`
  (`VITE_API_URL`). A API libera a origem `http://localhost:5173` via `CORS_ORIGIN`
  e aceita cookies de sessão (`credentials: true`).
- **Produção:** o front é compilado com `VITE_API_URL=/api`, então todas as chamadas
  são relativas e passam pelo nginx do serviço `web`, que encaminha `/api/*` para
  `api:3000` na rede interna do Docker. A API **não** é publicada no host.
- **Dados:** o globo da home e o painel consomem a trilha global
  (`/api/global/hotspots`, `/api/global/aggregates`). O calendário vem do
  agregado `data/db/aggregates.sqlite`; o SQLite linha a linha
  (`data/db/global.sqlite`) atende os endpoints legados. O ano corrente é
  complementado pela API do FIRMS em `data/raw/global/current/` e entra no
  agregado. Os endpoints `/api/hotspots`, `/api/regions` e `/api/calendar`
  continuam disponíveis para a trilha Brasil legada, controlada por
  `DATA_SOURCE`.
- Os cookies de sessão do painel funcionam nos dois modos (CORS com credenciais em dev,
  mesma origem em produção).

## Quickstart (Docker)

Pré-requisitos: Docker Desktop com Compose v2.

```bash
cp .env.example .env
# edite .env (DB_PASSWORD, FIRMS_MAP_KEY, portas, etc.)
docker compose up --build
```

| Serviço | URL |
| --- | --- |
| Web | http://localhost:5173 |
| API (health) | http://localhost:3000/api/health |
| API (meta) | http://localhost:3000/api/meta |
| API (global) | http://localhost:3000/api/global/status |
| API (execuções) | http://localhost:3000/api/runs (admin quando `ADMIN_TOKEN` está definido) |
| Postgres | `localhost:5432` (somente dev) |

O Compose de desenvolvimento usa bind mount e hot reload nos dois serviços. O
entrypoint da API aplica as migrações do Postgres automaticamente. O globo e o
painel usam a trilha global; para popular os dados no dev:

```bash
# 1. baixa os CSVs históricos (piloto)
docker compose exec -T api npm run global -- --countries all --max-files 20 --grid 10

# 2. gera o agregado com DuckDB (ver docs/GLOBAL.pt-BR.md)
docker run --rm --ulimit nofile=65536:65536 \
  -v carcara-orbit_api_data:/data \
  -v "$PWD/api/scripts:/scripts:ro" \
  python:3.12-slim \
  sh -c 'pip install --quiet duckdb && python /scripts/global_aggregate.py \
    --raw /data/raw/global --regions /data/runtime/global-regions.json \
    --out /data/db/aggregates.sqlite --tmp /data/db/duckdb-tmp'
```

Sem o agregado, o painel informa que a grade global ainda não tem dados.
`DATA_SOURCE=mock` afeta apenas os endpoints legados do Brasil.

### Postgres

- Serviço `db` (`postgres:16-alpine`) com volume `postgres_data`, healthcheck e
  rede interna.
- `DATABASE_URL` é montada a partir de `DB_USER`/`DB_PASSWORD`/`DB_NAME`
  (credenciais percent-encoded).
- Migrações ficam em [`api/db/migrations`](./api/db/migrations) e são aplicadas
  pelo entrypoint ou por `docker compose exec api npm run db:migrate`.
- A tabela `operation_runs` registra execuções de pipeline/NRT/modo e alimenta
  `GET /api/runs`. A série analítica de focos continua em SQLite/`data/real`
  nesta fase; a migração para Postgres/PostGIS está no roadmap.
- Em produção há backup diário no serviço `db-backup` (volume
  `postgres_backups`). Runbook em [`docs/DEPLOY.pt-BR.md`](./docs/DEPLOY.pt-BR.md).

### Dados reais (NASA FIRMS)

1. Obtenha uma `FIRMS_MAP_KEY` em <https://firms.modaps.eosdis.nasa.gov/api/map_key/>.
2. Preencha `FIRMS_MAP_KEY` no `.env`.
3. Para o modo real, defina `DATA_SOURCE=real` ou use
   `docker compose exec api npm run bootstrap` para baixar/importar o histórico.

O diretório `api/data` é o volume de trabalho do pipeline (`raw`, `real`, `db`,
`runtime`) e é persistido no volume `api_data` em produção. Detalhes em
[`api/docs/REAL-DATA.pt-BR.md`](./api/docs/REAL-DATA.pt-BR.md) e
[`api/pipeline/docs/PIPELINE.pt-BR.md`](./api/pipeline/docs/PIPELINE.pt-BR.md).

## Ingestão global (API)

A API possui uma trilha global separada do dataset Brasil usado pela web:

- baixa o histórico mundial da FIRMS (238 países, ~10 mil CSVs, ~43,5 GB);
- agrega os CSVs com DuckDB em `data/db/aggregates.sqlite` (célula × ano × mês ×
  sensor, calibração e amostra recente), sem importar 1 bilhão de linhas;
- baixa o ano corrente pela API do FIRMS em blocos de 5 dias (SP + NRT) para
  `data/raw/global/current/`, que o agregado lê como camada adicional;
- atribui cada foco a uma grade mundial (padrão 10°, 648 células);
- expõe o agregado completo, focos e CSV em `/api/global/*`;
- usa a disponibilidade do FIRMS para saber o ano corrente (NRT);
- opcionalmente mantém a trilha linha a linha legada em `global.sqlite`.

```bash
# Plano (não baixa)
docker compose exec api npm run global -- --dry-run --countries all --grid 10

# Piloto com 20 arquivos
docker compose exec api npm run global -- --countries all --max-files 20

# Carga histórica completa (depois rode o agregado DuckDB)
docker compose exec api npm run global -- --countries all

# Ano corrente (2026) via API do FIRMS, direto no volume da API
docker run --rm --ulimit nofile=65536:65536 \
  -v carcara-orbit_api_data:/data \
  -v "$PWD/api/scripts:/scripts:ro" \
  -e FIRMS_MAP_KEY="$FIRMS_MAP_KEY" \
  python:3.12-slim \
  python /scripts/fetch_current_year.py --year 2026 --delay 12
```

Endpoints principais:

| Rota | Descrição |
| --- | --- |
| `GET /api/global/status` | cobertura, grade, calibração e status do job |
| `GET /api/global/aggregates` | agregado harmonizado de todas as células |
| `GET /api/global/calendar?region=&bbox=&from=&to=` | calendário global harmonizado (legado) |
| `GET /api/global/hotspots?region=&bbox=&from=&to=&sensor=` | focos globais |
| `GET /api/global/export/hotspots.csv?...` | CSV global |
| `POST /api/global/ingest` | dispara a ingestão em background (admin) |
| `GET /api/global/ingest/status` | progresso do job |

A base global é independente do dataset Brasil: a web e suas seis regiões
continuam funcionando sem alterações. O runbook completo está em
[`docs/GLOBAL.pt-BR.md`](./docs/GLOBAL.pt-BR.md).

## Produção

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env up -d --build
```

Antes de subir:

- aponte o DNS de `APP_HOST` para o servidor;
- defina `DB_PASSWORD`, `APP_HOST` e `TRAEFIK_*` no `.env` (veja
  [`docs/DEPLOY.pt-BR.md`](./docs/DEPLOY.pt-BR.md#proxy-reverso-traefik-da-vps));
- conecte o `web` à rede do Traefik que já atende `80/443` na VPS.

O Traefik da VPS termina o TLS e encaminha para o nginx do `web` pela rede
compartilhada. O nginx serve os assets da SPA e faz proxy de `/api` para o
serviço `api`, que permanece inacessível diretamente pela internet. O Postgres
não publica porta no host e roda com backup diário.

Os dados do globo e do painel vêm da trilha global: o agregado
`data/db/aggregates.sqlite` (DuckDB) e os CSVs originais, persistidos no volume
`api_data`. O runbook está em
[`docs/DEPLOY.pt-BR.md`](./docs/DEPLOY.pt-BR.md#dados-analíticos-na-vps) e
[`docs/GLOBAL.pt-BR.md`](./docs/GLOBAL.pt-BR.md).

## CI/CD e deploy na VPS

O workflow [`.github/workflows/ci.yml`](./.github/workflows/ci.yml):

1. valida API e web (lint, build, testes unitários e do pipeline);
2. sobe um Postgres de serviço, aplica migrações e testa `/api/health`;
3. valida os Compose e constrói as imagens Docker;
4. com a variável `DEPLOY_ENABLED=true`, copia o repo para
   `~/dev/carcara-orbit`, escreve o `.env` a partir dos secrets e das variáveis
   `TRAEFIK_*`, sobe o Compose de produção, confere a saúde e remove o `.env`.

Secrets e passos detalhados: [`docs/DEPLOY.pt-BR.md`](./docs/DEPLOY.pt-BR.md).

## Desenvolvimento sem Docker

```bash
# Postgres (opcional; sem ele a API sobe com persistência desativada)
docker compose up -d db

# API
cd api
npm ci
DATABASE_URL=postgresql://carcara:change-me-strong-password@localhost:5432/carcara \
  npm run db:migrate
npm run start:dev        # http://localhost:3000/api

# Web (outro terminal)
cd web
npm ci
npm run dev              # http://localhost:5173
```

## Scripts úteis

| Comando | O que faz |
| --- | --- |
| `docker compose up --build` | Sobe dev com hot reload |
| `docker compose logs -f api` | Acompanha os logs da API |
| `docker compose exec api npm run bootstrap` | Baixa/importa o histórico FIRMS do Brasil |
| `docker compose exec api npm run global -- --dry-run --countries all` | Plano da ingestão mundial |
| `docker compose exec api npm run global -- --countries all --max-files 20` | Piloto da ingestão mundial |
| `docker compose exec api npm run pipeline` | Roda o pipeline histórico |
| `docker compose exec api npm run db:migrate` | Aplica migrações pendentes |
| `docker compose exec api npm test` | Testes unitários da API |
| `docker compose exec api npm run pipeline:test` | Testes do pipeline |
| `docker compose exec web npm run lint` | Lint do front |

## Documentação

- [`docs/GLOBAL.pt-BR.md`](./docs/GLOBAL.pt-BR.md) — ingestão global, grade, endpoints e operação.
- [`docs/REQUISITOS.pt-BR.md`](./docs/REQUISITOS.pt-BR.md) — aderência ao desafio e roadmap.
- [`docs/DEPLOY.pt-BR.md`](./docs/DEPLOY.pt-BR.md) — VPS, secrets, migrações, backup/restore.
- [`docs/apresentacao/README.pt-BR.md`](./docs/apresentacao/README.pt-BR.md) — apresentação do projeto (EN/PT).
- [`api/docs/REAL-DATA.pt-BR.md`](./api/docs/REAL-DATA.pt-BR.md) — dados reais e NRT.
- [`api/pipeline/docs/PIPELINE.pt-BR.md`](./api/pipeline/docs/PIPELINE.pt-BR.md) — pipeline FIRMS.

## Licença

Projeto privado da Carcará Orbit Fortaleza.
