# Deploy em VPS e CI/CD

O fluxo segue o padrão do [Baseware](https://github.com/platusforge/baseware):
GitHub Actions valida o monorepo, copia os arquivos para a VPS por SCP, escreve
o `.env` a partir dos secrets e variáveis, sobe o Compose de produção e remove
o `.env`.

Este projeto **não sobe Traefik**. O Traefik que já atende `80/443` na VPS é o
edge: o container `web` entra na rede dele e recebe as labels do subdomínio.
Veja [Proxy reverso](#proxy-reverso-traefik-da-vps).

## Pré-requisitos da VPS

- Docker Engine + Compose v2.
- Traefik já rodando em `80/443`, com ACME/Let's Encrypt configurado.
- DNS de `APP_HOST` apontando para o IP da VPS.
- Usuário com acesso ao Docker (ou `sudo` configurado para o usuário do deploy).
- Diretório de deploy: `~/dev/carcara-orbit`.

## Variáveis do repositório

Crie em `Settings → Secrets and variables → Actions → Variables`:

| Variável | Padrão | Uso |
| --- | --- | --- |
| `DEPLOY_ENABLED` | — | `true` liga o job `deploy`; sem ela só o `verify` roda |
| `TRAEFIK_NETWORK` | `traefik-proxy` | rede Docker do Traefik da VPS |
| `TRAEFIK_ENTRYPOINT` | `websecure` | entrypoint de TLS do Traefik |
| `TRAEFIK_CERT_RESOLVER` | `le` | certresolver ACME do Traefik |

Sem `DEPLOY_ENABLED=true`, o job `deploy` é ignorado e apenas o `verify` roda.
Isso evita deploys acidentais antes dos secrets estarem configurados. Para
desativar o deploy, basta remover a variável.

## Secrets obrigatórios

| Secret | Exemplo / observação |
| --- | --- |
| `HOST` | IP ou hostname da VPS |
| `USERNAME` | usuário SSH |
| `PRIVATE_KEY` | chave privada SSH (conteúdo completo) |
| `SSH_PORT` | `22` |
| `DB_USER` | `carcara` |
| `DB_PASSWORD` | senha forte; obrigatória |
| `DB_NAME` | `carcara` |
| `APP_HOST` | subdomínio público, ex. `orbit.exemplo.org` |

> `ADMIN_EMAIL` não é mais usado por este projeto: o certificado é emitido pelo
> Traefik que já roda na VPS.

### Secrets opcionais

| Secret | Padrão | Uso |
| --- | --- | --- |
| `DB_POOL_MAX` | `10` | conexões do pool da API |
| `API_PORT` | `3000` | porta interna da API |
| `FIRMS_MAP_KEY` | vazio | NRT/backfill da NASA FIRMS |
| `DATA_SOURCE` | `mock` | `mock` ou `real` |
| `ADMIN_TOKEN` | vazio | protege `/api/mode`, `/api/ingestion/run`, `/api/nrt/refresh` |
| `NRT_ENABLED` | `false` | agenda de atualização NRT |
| `NRT_INTERVAL_MINUTES` | `180` | intervalo do NRT |
| `NRT_DAYS` | `2` | janela do NRT (máx. 5) |
| `NRT_REGIONS` | vazio | regiões do NRT |
| `FIRMS_SOURCES` | MODIS/VIIRS NRT | fontes do NRT |
| `FIRMS_COUNTRY` | `Brazil` | país do bootstrap histórico |
| `REGIONS_FILE` | regiões do repo | GeoJSON de regiões customizado |
| `GLOBAL_GRID_DEGREES` | `10` | grade da ingestão mundial (5–60) |
| `GLOBAL_NRT_TILE_DEGREES` | `30` | tiles do NRT global |
| `GLOBAL_START_YEAR` | `2000` | início da carga global |
| `GLOBAL_END_YEAR` | ano anterior | fim da carga global |
| `GLOBAL_MAX_FILES` | ilimitado | limite de arquivos por execução |
| `MAX_MAP_POINTS` | `2000` | limite do GeoJSON de mapa |
| `MAX_EXPORT_ROWS` | `50000` | limite de exportação |

> `DATABASE_URL` não precisa ser configurada: o Compose passa `DB_*` e a API
> monta a URL com as credenciais percent-encoded.

> `API_PORT` é a porta **interna** da rede do Compose. Em produção ela não é
> publicada no host, então não conflita com nenhum outro serviço que já use
> `3000` na VPS. Apenas o modo desenvolvimento (`docker-compose.override.yml`)
> publica `API_PORT`, `WEB_PORT` e `DB_PORT` no host.

## Proxy reverso (Traefik da VPS)

O `docker-compose.prod.yml` não publica `80/443` e não cria Traefik. O serviço
`web` é conectado à rede do Traefik existente (`TRAEFIK_NETWORK`) e recebe estas
labels:

- `traefik.enable=true`
- `traefik.docker.network=$TRAEFIK_NETWORK`
- `traefik.http.routers.carcara-orbit.rule=Host($APP_HOST)`
- `traefik.http.routers.carcara-orbit.entrypoints=$TRAEFIK_ENTRYPOINT`
- `traefik.http.routers.carcara-orbit.tls.certresolver=$TRAEFIK_CERT_RESOLVER`
- `traefik.http.services.carcara-orbit.loadbalancer.server.port=80`

Descubra os valores na VPS:

```bash
TRAEFIK=$(docker ps --format '{{.Names}}' | grep -i traefik | head -n1)

# modo de rede: "host" exige o fallback abaixo; "bridge" (padrão) usa a rede
docker inspect "$TRAEFIK" --format '{{.HostConfig.NetworkMode}}'

# rede(s) do Traefik — use o nome exato em TRAEFIK_NETWORK
docker inspect "$TRAEFIK" \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}'

# entrypoints e certresolver
docker inspect "$TRAEFIK" --format '{{json .Args}}' | tr ',' '\n' \
  | grep -E 'entrypoints|certresolver|providers.docker'
```

- **Rede:** o nome exato em `docker network ls` (ex. `traefik`, `proxy`,
  `traefik_default`). É o valor de `TRAEFIK_NETWORK`. Ignore `bridge`/`host`:
  use a rede user-defined que o Traefik compartilha com os serviços.
- **Entrypoint:** o que aponta para `:443` (normalmente `websecure`).
- **Certresolver:** o `<nome>` de
  `--certificatesresolvers.<nome>.acme...` (ex. `le`, `letsencrypt`).

> Se o Traefik usa arquivo de configuração em vez de flags, os mesmos nomes
> estão no `traefik.yml`/`traefik.toml` do container ou no dashboard.

Um Traefik típico em container usa `providers.docker.exposedbydefault=false`, o
que combina com as labels acima. A API e o Postgres têm `traefik.enable=false`
para nunca serem roteados, mesmo que o Traefik exponha containers por padrão.

Se a rede ainda não existir, crie e conecte o Traefik:

```bash
docker network create traefik-proxy
docker network connect traefik-proxy "$TRAEFIK"
```

> Traefik em `network_mode: host` não alcança containers por nome. Nesse caso,
> publique o `web` em `127.0.0.1:8080` (override com
> `ports: ["127.0.0.1:8080:80"]`) e crie um router no file provider apontando
> para `http://127.0.0.1:8080`.

Depois do deploy, valide o caminho público:

```bash
curl -I "https://$APP_HOST"
curl -fsS "https://$APP_HOST/api/health"
```

### Troubleshooting do proxy

| Sintoma | Causa provável |
| --- | --- |
| `network ... declared as external, but could not be found` | `TRAEFIK_NETWORK` errado; ajuste a variável ou crie a rede |
| 404 do Traefik | `web` fora da rede, `traefik.enable=true` ausente ou provider Docker do Traefik desabilitado |
| 404 e `docker inspect <web> --format '{{.State.Health.Status}}'` mostra `unhealthy` | Traefik ignora containers unhealthy; corrija o healthcheck (use `127.0.0.1`, não `localhost`) |
| 404 e `web` não aparece no dashboard do Traefik | `providers.docker.constraints` do Traefik exclui o container |
| `certificate resolver ... does not exist` / TLS inválido | `TRAEFIK_CERT_RESOLVER` não corresponde ao ACME do Traefik |
| 502 Bad Gateway | `web` unhealthy ou `traefik.http.services...server.port` diferente de `80` |

## O que o workflow faz

1. **verify** (push/PR na `main`):
   - instala dependências de `api/` e `web/`;
   - roda lint, build e testes unitários;
   - roda os testes do pipeline e a suíte e2e;
   - sobe um Postgres de serviço, aplica as migrações e testa `/api/health`;
   - valida os dois arquivos de Compose;
   - constrói as imagens Docker de API e web.
2. **deploy** (push na `main`, se `DEPLOY_ENABLED=true`):
   - copia o repositório para `~/dev/carcara-orbit`;
   - escreve `.env` a partir dos secrets e das variáveis `TRAEFIK_*`;
   - executa `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --force-recreate --remove-orphans` (sem publicar `80/443`);
   - o entrypoint da API aplica as migrações pendentes no boot;
   - espera `/api/health` ficar `ok` com Postgres conectado (com retry);
   - remove o `.env` ao final (mesmo em caso de erro).

## Deploy manual

```bash
cd ~/dev/carcara-orbit
cp .env.example .env
# edite DB_*, APP_HOST, TRAEFIK_* e demais variáveis
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env up -d --build --force-recreate --remove-orphans
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env exec -T api node scripts/migrate.mjs
rm .env
```

## Migrações

As migrações ficam em `api/db/migrations` e são controladas por
`schema_migrations`. O entrypoint da API aplica as pendentes em todo boot:

```bash
docker compose exec api npm run db:migrate
```

Para criar uma migração, adicione um novo arquivo `.sql` numerado. Não edite uma
migração já aplicada em produção.

## Banco de dados

- `db`: PostgreSQL 16 com volume `postgres_data`.
- `db-backup`: backup diário com retenção de 7 dias, 4 semanas e 6 meses no
  volume `postgres_backups`.
- A porta `5432` é publicada somente no Compose de desenvolvimento; em produção
  o banco fica restrito à rede interna.

### Backup e restore

```bash
# listar backups
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec db-backup ls -l /backups

# restore (janela de manutenção)
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
docker volume rm carcara-orbit_postgres_data
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d db
gunzip -c backups/latest.sql.gz | docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db psql -U "$DB_USER" -d "$DB_NAME"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

> O nome do volume é prefixado pelo projeto Compose (`carcara-orbit_`). Confira
> com `docker volume ls` antes de remover.

## Dados analíticos na VPS

Nesta fase, o Postgres guarda o histórico operacional (`operation_runs`) e a
saúde do serviço. A série analítica continua em `data/db/firms.sqlite` e em
`data/real/`, persistidos no volume `api_data`.

Para carregar dados reais após o primeiro deploy:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env exec -T api npm run bootstrap
```

Depois, ajuste `DATA_SOURCE=real` e reinicie a API.

### Ingestão global

A trilha mundial grava em `data/db/global.sqlite` e não interfere no dataset
Brasil. Na VPS:

```bash
cd ~/dev/carcara-orbit

# 1. Piloto (não baixa os ~43 GB)
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env exec -T api npm run global -- \
  --dry-run --countries all --grid 10 --max-files 20 --json

# 2. Carga em lotes (retomável)
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env exec -T api npm run global -- \
  --countries all --grid 10 --max-files 200

# 3. Repetir até completar; acompanhar
curl https://$APP_HOST/api/global/status

# 4. Atualização NRT do ano corrente (requer FIRMS_MAP_KEY)
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env exec -T api npm run global -- --current --grid 10
```

Também é possível disparar pela API:

```bash
curl -X POST https://$APP_HOST/api/global/ingest \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -d '{"countries":"all","maxFiles":200,"gridDegrees":10}'
```

Acompanhe `data/db/global.sqlite`, `data/runtime/global-download.json` e
`data/runtime/global-ingestion.json` no volume `api_data`. O caminho para
PostGIS e escala está em [`REQUISITOS.md`](./REQUISITOS.md).

## Rollback

O deploy não versiona imagens com tag própria. Para voltar uma versão:

```bash
cd ~/dev/carcara-orbit
git log --oneline -5
git checkout <commit-anterior>
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Como o workflow copia a working tree, um novo push na `main` volta a sobrescrever
o diretório; faça o rollback via um commit de revert, não apenas no servidor.
