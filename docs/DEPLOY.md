# Deploy em VPS e CI/CD

O fluxo segue o padrão do [Baseware](https://github.com/platusforge/baseware):
GitHub Actions valida o monorepo, copia os arquivos para a VPS por SCP, escreve
o `.env` a partir dos secrets, sobe o Compose de produção e remove o `.env`.

## Pré-requisitos da VPS

- Docker Engine + Compose v2.
- Portas `80` e `443` liberadas (Traefik/Let's Encrypt).
- DNS de `APP_HOST` apontando para o IP da VPS.
- Usuário com acesso ao Docker (ou `sudo` configurado para o usuário do deploy).
- Diretório de deploy: `~/dev/carcara-orbit`.

## Variável do repositório

Crie a variável **`DEPLOY_ENABLED`** com valor `true` em
`Settings → Secrets and variables → Actions → Variables`.

Sem ela, o job `deploy` é ignorado e apenas o `verify` roda. Isso evita deploys
acidentais antes dos secrets estarem configurados. Para desativar o deploy,
basta remover a variável.

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
| `APP_HOST` | domínio público, ex. `orbit.exemplo.org` |
| `ADMIN_EMAIL` | e-mail para o Let's Encrypt |

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
| `MAX_MAP_POINTS` | `2000` | limite do GeoJSON de mapa |
| `MAX_EXPORT_ROWS` | `50000` | limite de exportação |

> `DATABASE_URL` não precisa ser configurada: o Compose passa `DB_*` e a API
> monta a URL com as credenciais percent-encoded.

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
   - escreve `.env` a partir dos secrets;
   - executa `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --force-recreate --remove-orphans`;
   - reaplica as migrações (idempotente);
   - falha se `/api/health` não estiver `ok` com Postgres conectado;
   - remove o `.env` ao final (mesmo em caso de erro).

## Deploy manual

```bash
cd ~/dev/carcara-orbit
cp .env.example .env
# edite DB_*, APP_HOST, ADMIN_EMAIL e demais variáveis
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

Depois, ajuste `DATA_SOURCE=real` e reinicie a API. O caminho para escala global
(Postgres/PostGIS) está detalhado em [`REQUISITOS.md`](./REQUISITOS.md).

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
