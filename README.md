# Carcará Orbit

Monorepo do Carcará Orbit: painel e API de monitoramento de focos de calor.
A web atual usa dados e regiões do Brasil; a API também oferece uma trilha de
ingestão e consulta global (ver [`docs/GLOBAL.md`](./docs/GLOBAL.md) e
[`docs/REQUISITOS.md`](./docs/REQUISITOS.md)).

| Pasta | Stack | Descrição |
| --- | --- | --- |
| [`api/`](./api) | NestJS 12 · TypeScript · Node 24 | API de focos, calendário, regiões, exportação e pipeline FIRMS |
| [`web/`](./web) | React 19 · Vite 7 · Tailwind 4 | Site público e painel (`/painel`) |

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
entrypoint da API aplica as migrações do Postgres automaticamente. Por padrão a
API sobe em `DATA_SOURCE=mock`, com os dados de `api/data/mock`.

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
  `postgres_backups`). Runbook em [`docs/DEPLOY.md`](./docs/DEPLOY.md).

### Dados reais (NASA FIRMS)

1. Obtenha uma `FIRMS_MAP_KEY` em <https://firms.modaps.eosdis.nasa.gov/api/map_key/>.
2. Preencha `FIRMS_MAP_KEY` no `.env`.
3. Para o modo real, defina `DATA_SOURCE=real` ou use
   `docker compose exec api npm run bootstrap` para baixar/importar o histórico.

O diretório `api/data` é o volume de trabalho do pipeline (`raw`, `real`, `db`,
`runtime`) e é persistido no volume `api_data` em produção. Detalhes em
[`api/docs/REAL-DATA.md`](./api/docs/REAL-DATA.md) e
[`api/pipeline/docs/PIPELINE.md`](./api/pipeline/docs/PIPELINE.md).

## Ingestão global (API)

A API possui uma trilha global separada do dataset Brasil usado pela web:

- baixa o histórico mundial da FIRMS (238 países, ~10 mil CSVs, ~43,5 GB);
- importa para `data/db/global.sqlite`, com checkpoint e retomada;
- atribui cada foco a uma grade mundial (padrão 10°, 648 células);
- calcula clusters e calibração VIIRS/MODIS por célula/mês;
- expõe calendário, focos e CSV para qualquer célula ou bbox em `/api/global/*`;
- opcionalmente busca o NRT atual em tiles globais (`FIRMS_MAP_KEY`).

```bash
# Plano (não baixa)
docker compose exec api npm run global -- --dry-run --countries all --grid 10

# Piloto com 20 arquivos
docker compose exec api npm run global -- --countries all --max-files 20

# Carga completa + NRT atual
docker compose exec api npm run global -- --countries all --current
```

Endpoints principais:

| Rota | Descrição |
| --- | --- |
| `GET /api/global/status` | cobertura, grade, calibração e status do job |
| `GET /api/global/calendar?region=&bbox=&from=&to=` | calendário global harmonizado |
| `GET /api/global/hotspots?region=&bbox=&from=&to=&sensor=` | focos globais |
| `GET /api/global/export/hotspots.csv?...` | CSV global |
| `POST /api/global/ingest` | dispara a ingestão em background (admin) |
| `GET /api/global/ingest/status` | progresso do job |

A base global é independente do dataset Brasil: a web e suas seis regiões
continuam funcionando sem alterações. O runbook completo está em
[`docs/GLOBAL.md`](./docs/GLOBAL.md).

## Produção

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env up -d --build
```

Antes de subir:

- aponte o DNS de `APP_HOST` para o servidor;
- defina `DB_PASSWORD`, `APP_HOST` e `TRAEFIK_*` no `.env` (veja
  [`docs/DEPLOY.md`](./docs/DEPLOY.md#proxy-reverso-traefik-da-vps));
- conecte o `web` à rede do Traefik que já atende `80/443` na VPS.

O Traefik da VPS termina o TLS e encaminha para o nginx do `web` pela rede
compartilhada. O nginx serve os assets da SPA e faz proxy de `/api` para o
serviço `api`, que permanece inacessível diretamente pela internet. O Postgres
não publica porta no host e roda com backup diário.

## CI/CD e deploy na VPS

O workflow [`.github/workflows/ci.yml`](./.github/workflows/ci.yml):

1. valida API e web (lint, build, testes unitários e do pipeline);
2. sobe um Postgres de serviço, aplica migrações e testa `/api/health`;
3. valida os Compose e constrói as imagens Docker;
4. com a variável `DEPLOY_ENABLED=true`, copia o repo para
   `~/dev/carcara-orbit`, escreve o `.env` a partir dos secrets e das variáveis
   `TRAEFIK_*`, sobe o Compose de produção, confere a saúde e remove o `.env`.

Secrets e passos detalhados: [`docs/DEPLOY.md`](./docs/DEPLOY.md).

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

- [`docs/GLOBAL.md`](./docs/GLOBAL.md) — ingestão global, grade, endpoints e operação.
- [`docs/REQUISITOS.md`](./docs/REQUISITOS.md) — aderência ao desafio e roadmap.
- [`docs/DEPLOY.md`](./docs/DEPLOY.md) — VPS, secrets, migrações, backup/restore.
- [`api/docs/REAL-DATA.md`](./api/docs/REAL-DATA.md) — dados reais e NRT.
- [`api/pipeline/docs/PIPELINE.md`](./api/pipeline/docs/PIPELINE.md) — pipeline FIRMS.

## Licença

Projeto privado da Carcará Orbit Fortaleza.
