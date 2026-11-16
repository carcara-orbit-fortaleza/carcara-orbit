[English](REAL-DATA.md) · **Português**

# Dados reais e API NRT (DEV-09)

Este projeto NestJS serve a API mock existente e agora também suporta dados reais
do FIRMS por meio de um worker de pipeline separado.

> **Postgres (produção):** a API se conecta ao Postgres para verificações de saúde,
> migrations de schema e o log operacional de execuções (`operation_runs`, exposto em
> `GET /api/runs`). O histórico analítico de focos ainda vive no SQLite e nos arquivos
> JSON gerados em `data/real` nesta fase. A migração dessa série para
> Postgres/PostGIS está registrada em `docs/REQUISITOS.pt-BR.md`.

> **Ingestão global:** um pipeline mundial separado baixa todos os CSVs por país do
> FIRMS para `data/db/global.sqlite` e expõe `/api/global/*`. Veja
> [`docs/GLOBAL.md`](../../docs/GLOBAL.pt-BR.md). Ele não altera o conjunto de dados do
> Brasil usado pelo web.

## Modos de dados

| Modo | Origem | Como habilitar |
|---|---|---|
| `mock` | `data/mock/` | Padrão |
| `real` | `data/real/` | Gere o conjunto de dados e depois `POST /api/mode` |

`GET /api/config` informa o modo ativo e a disponibilidade. Um modo salvo em
`data/runtime/mode.json` tem precedência sobre `DATA_SOURCE`.

## Armazenamento histórico em SQLite

`data/db/firms.sqlite` guarda os focos históricos normalizados, importados dos
CSVs públicos anuais por país do FIRMS. `data/real` é regenerado a partir dele por
`npm run bootstrap`, `npm run pipeline` ou `npm run nrt`. A API continua lendo os
arquivos JSON, então nenhuma mudança no cliente da API é necessária.

```text
data/db/firms.sqlite        normalized hotspots + monthly clusters
data/raw/country/           scraped historical CSVs
data/runtime/import.json    CSV import checkpoint
data/real/                  generated dataset consumed by the API
```

`hotspots.geojson` exporta apenas os últimos `HOTSPOTS_EXPORT_MONTHS` (padrão 24)
meses para manter o arquivo pequeno. O histórico completo continua consultável no
SQLite.

## Endpoints

Os endpoints existentes mantêm seus contratos:

| Método | Rota | Observações |
|---|---|---|
| GET | `/api/health` | Inclui o `dataSource` ativo |
| GET | `/api/meta` | Metadados do conjunto de dados ativo |
| GET | `/api/regions` | Regiões ativas |
| GET | `/api/regions.geojson` | Regiões ativas como GeoJSON |
| GET | `/api/calendar?region=&from=&to=` | Calendário e métricas |
| GET | `/api/hotspots?region=&from=&to=&sensor=&bbox=&limit=` | Focos em GeoJSON |
| GET | `/api/export.csv?region=&from=&to=` | CSV do calendário |

Novos endpoints de dados reais:

| Método | Rota | Observações |
|---|---|---|
| GET | `/api/config` | Modo, disponibilidade, período ativo, regiões |
| GET | `/api/datasets` | Disponibilidade e último `run-meta` |
| POST | `/api/mode` | Alterna `{"mode":"mock"}` / `{"mode":"real"}` |
| POST | `/api/ingestion/run` | Executa o pipeline histórico a partir de `data/raw` |
| GET | `/api/nrt/status` | Estado do agendador e `keyConfigured` |
| POST | `/api/nrt/refresh` | Dispara uma atualização NRT (202) |
| GET | `/api/export/hotspots.csv?region=&from=&to=&sensor=&bbox=` | CSV de focos filtrados |
| GET | `/api/runs?limit=20` | Histórico de execuções operacionais do Postgres (admin quando `ADMIN_TOKEN` está definido) |
| GET | `/api/global/status` | Cobertura da ingestão mundial e estado do job |
| GET | `/api/global/calendar?region=&bbox=&from=&to=` | Calendário de grid/AOI global |
| GET | `/api/global/hotspots?region=&bbox=&from=&to=&sensor=` | Busca de focos global |
| POST | `/api/global/ingest` | Inicia a ingestão mundial (admin) |

## Proteção de admin

Defina `ADMIN_TOKEN` para proteger:

- `POST /api/mode`
- `POST /api/ingestion/run`
- `POST /api/nrt/refresh`

Envie `Authorization: Bearer <token>` ou `X-Admin-Token: <token>`.

## Ingestão histórica

### Preparar o banco SQLite

`npm run bootstrap` é a forma de um comando só para popular uma instalação nova. O
armazenamento histórico é `data/db/firms.sqlite`; `data/real` é gerado a partir dele.

Quando o banco está vazio, o script:

1. faz scraping do índice público de CSVs anuais por país, linkado na página FIRMS
   Archive Download (`/data/country/yearly_summary_files.txt`);
2. baixa os CSVs históricos para `data/raw/country/`;
3. faz streaming de todos os CSVs para o SQLite, com um checkpoint de importação
   retomável;
4. busca **apenas a janela NRT atual** pela FIRMS Area API;
5. agrupa/agrega o banco e reconstrói `data/real`.

O índice público por país cobre MODIS C6.1, VIIRS S-NPP e VIIRS NOAA-20. O
histórico do Brasil tem ~48 CSVs e ~3,2 GB. O NOAA-21 é coberto pela janela NRT
atual porque o índice por país não tem arquivos anuais do NOAA-21.

```bash
npm run bootstrap

# Inspect the plan first
npm run bootstrap -- --dry-run

# Pilot: two CSVs and no current API call
npm run bootstrap -- --max-files 2 --no-current

# Re-run/complete the import even if the database exists
npm run bootstrap -- --force

# Regenerate data/real from SQLite without new downloads/API
npm run bootstrap -- --rebuild-only

# Recreate the database and checkpoints
npm run bootstrap -- --reset

# Rebuild even if some downloads/imports failed
npm run bootstrap -- --allow-partial
```

Se a importação histórica estiver incompleta, o script mantém o conjunto `data/real`
anterior, a menos que `--allow-partial` seja passado.

Configurações de ambiente úteis:

```dotenv
FIRMS_DB_PATH=./data/db/firms.sqlite
FIRMS_COUNTRY=Brazil
FIRMS_HISTORY_START_YEAR=2000
HOTSPOTS_EXPORT_MONTHS=24
# Optional: load region polygons from another GeoJSON file.
# REGIONS_FILE=./pipeline/config/regions.json
```

`FIRMS_COUNTRY` aceita qualquer país listado pelo índice anual por país do FIRMS.
Para outras áreas, `backfill --bbox=west,south,east,north` aceita qualquer extensão
da FIRMS Area API. O endpoint `/api/hotspots` e a exportação CSV de focos também
aceitam um `bbox` livre. Note que os calendários e a UI web ainda são organizados
em torno das regiões configuradas; veja `docs/REQUISITOS.pt-BR.md` para a lacuna de
escopo global.

O formulário do FIRMS Archive Download ainda exige uma sessão autenticada do
Earthdata/email, mas os arquivos anuais por país usados aqui são públicos e listados
pelo mesmo site.

### Legado: backfill automatizado pela Area API

`npm run bootstrap` não usa mais esse caminho. Ele continua disponível para
downloads em massa por blocos quando você quiser explicitamente a Area API em vez
dos CSVs públicos anuais por país.

O projeto pode baixar dados históricos de processamento padrão diretamente pela
FIRMS Area API usando a `FIRMS_MAP_KEY` existente:

```bash
npm run backfill -- --start 2000-11-01 --end 2026-10-31 `
  --sources MODIS_SP,VIIRS_SNPP_SP,VIIRS_NOAA20_SP,VIIRS_NOAA21_SP `
  --bbox=-74,-34,-34,6
```

- Os blocos são limitados a **5 dias** pela FIRMS API.
- O checkpoint é `data/runtime/backfill.json`; reexecuções retomam automaticamente.
- Os arquivos são gravados em `data/raw/<source>/<start>_<end>.csv`.
- Use `--region pantanal` ou `--region cerrado` para uma AOI menor.
- Use `--dry-run` para ver o plano e `--max-requests N` para um piloto.
- O plano completo Brasil/4 fontes tem ~3.900 blocos; prefira uma região/fonte por
  vez se disco/tempo forem limitados.

Depois do backfill:

```bash
npm run pipeline
```

### Importação manual de arquivos

1. Baixe os CSVs do arquivo MODIS/VIIRS do FIRMS.
2. Coloque-os em `data/raw/country/` (subdiretórios são suportados).
3. Execute a partir da raiz do projeto:

```bash
npm run pipeline
```

Para importar de outro diretório, use
`node pipeline/src/cli.js pipeline --input data/raw`. Se o SQLite existir, a
importação e a reconstrução do conjunto de dados usam o banco.

Ou pela API:

```bash
curl -X POST http://127.0.0.1:3000/api/ingestion/run \
  -H "Content-Type: application/json" \
  -d '{"inputDir":"data/raw"}'
```

O pipeline grava `data/real/`; depois troque:

```bash
curl -X POST http://127.0.0.1:3000/api/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"real"}'
```

## NRT

Configure o `.env` na raiz do projeto:

```dotenv
FIRMS_MAP_KEY=...
NRT_ENABLED=true
NRT_INTERVAL_MINUTES=180
NRT_DAYS=2
NRT_REGIONS=pantanal,cerrado
```

O agendador busca os últimos `NRT_DAYS` (máximo de 5 pela FIRMS Area API). Quando
`data/db/firms.sqlite` existe, ele faz upsert apenas desses focos atuais no SQLite,
recalcula os meses afetados e reconstrói `data/real` a partir do banco completo. Sem
SQLite, ele mantém o comportamento legado de merge em
`data/real/raw/hotspots.jsonl`.

Disparo manual:

```bash
curl -X POST http://127.0.0.1:3000/api/nrt/refresh
curl http://127.0.0.1:3000/api/nrt/status
```

Se uma atualização falhar, o conjunto de dados real anterior é mantido e o
`lastError` é registrado.

## Testes

```bash
npm test              # unit tests
npm run test:e2e      # existing + real-mode/API tests
npm run pipeline:test # pipeline worker tests
npm run build
```

## Checklist do DEV-09

- [x] Conjuntos de dados mock e real separados.
- [x] Modo real apenas quando `data/real/calendario.json` existe.
- [x] Ingestão de CSVs históricos do FIRMS.
- [x] Busca, merge e reconstrução NRT.
- [x] Agendador NRT e API de status/disparo.
- [x] Falha mantém o último conjunto de dados válido.
- [x] Exportação CSV de focos filtrados.
- [x] Testes com fetch falso do FIRMS e API em modo real.
- [ ] Painel web visual (fora de escopo).
- [ ] Histórico global em escala de produção (próximo passo: DuckDB/PostGIS/tiles).

## Atribuição

Dados reais: NASA FIRMS / NASA Earthdata (MODIS C6.1 e VIIRS 375 m). Siga os
requisitos de reconhecimento e isenção de responsabilidade do FIRMS ao redistribuir
dados ou produtos derivados.
