[English](README.md) · **Português**

# Worker do pipeline do Carcará

Worker Node.js independente dentro do projeto NestJS. Ele é responsável pelo
trabalho pesado com dados:

- normalizar os arquivos CSV MODIS/VIIRS do FIRMS;
- filtrar confiança e atribuir regiões;
- deduplicar focos (1 km / 3 h);
- agregar em um grid de 0,1°;
- calibrar na sobreposição de 2012–2025;
- harmonizar a série;
- gravar o conjunto de dados real consumido pela API Nest.

Ele não tem dependências npm e é intencionalmente separado do processo HTTP. O
importador SQLite usa o `node:sqlite` nativo do Node (Node.js 22.5+).

## Comandos (executados a partir da raiz do projeto)

```bash
# Historical CSV import + current API window + rebuild data/real
npm run bootstrap

# Import CSVs already in data/raw/country -> SQLite -> data/real
npm run pipeline

# One-shot NRT refresh -> data/real
npm run nrt

# Worker tests
npm run pipeline:test

# Status without the API
node pipeline/src/cli.js status

# Legacy: historical chunks through the FIRMS Area API
npm run backfill -- --start 2000-11-01 --end 2026-10-31 `
  --sources MODIS_SP,VIIRS_SNPP_SP,VIIRS_NOAA20_SP,VIIRS_NOAA21_SP `
  --bbox=-74,-34,-34,6
```

`data/db/firms.sqlite` é o armazenamento histórico. `data/real` é gerado a partir
dele. `npm run bootstrap` não faz nada quando o banco SQLite já tem focos, a menos
que `--force` ou `--reset` seja usado.

## Como o banco é populado

1. **CSVs históricos (scraping).** O script lê o índice público por trás da página
   FIRMS Archive Download (`/data/country/yearly_summary_files.txt`) e baixa os
   CSVs anuais por país para `data/raw/country/`. Diferente do formulário de
   download, esse índice não exige uma sessão do Earthdata/email.
2. **Importação para o SQLite.** Todo CSV em `data/raw/country/` é enviado em
   streaming para `data/db/firms.sqlite` (tabela `hotspots`) em lotes. O checkpoint
   é `data/runtime/import.json`, então uma importação interrompida retoma sem
   reler os arquivos já concluídos.
3. **Dados atuais (somente API).** Apenas a janela NRT atual (padrão 2 dias, máximo
   de 5 por requisição) é buscada pela FIRMS Area API usando `FIRMS_MAP_KEY` e
   inserida (upsert) no mesmo banco.
4. **Geração do conjunto de dados.** O script agrupa o banco por mês, agrega as
   contagens do calendário e regenera `data/real`.

O histórico do Brasil tem ~48 CSVs e ~3,2 GB (MODIS C6.1, VIIRS S-NPP e VIIRS
NOAA-20). O índice público por país não publica arquivos anuais do NOAA-21; esse
sensor é coberto pela janela NRT atual.

```bash
# Populate only if empty; keep the current database otherwise
npm run bootstrap

# Inspect the download plan without downloading or writing
npm run bootstrap -- --dry-run

# Pilot: two historical CSVs, no current API call
npm run bootstrap -- --max-files 2 --no-current

# Finish/refresh even when the database already has data
npm run bootstrap -- --force

# Regenerate data/real from the SQLite database, without new downloads/API
npm run bootstrap -- --rebuild-only

# Recreate the database and checkpoints from scratch
npm run bootstrap -- --reset

# Rebuild with partial data when some downloads/imports failed
npm run bootstrap -- --allow-partial

# Import CSVs from a custom directory
npm run bootstrap -- --csv-dir data/raw
```

Comandos úteis para piloto:

```bash
# Plan only, no downloads
node pipeline/src/cli.js backfill --start 2001-01-01 --end 2001-01-10 \
  --sources MODIS_SP --region pantanal --dry-run

# Download 10 chunks and stop
node pipeline/src/cli.js backfill --start 2010-01-01 --end 2011-12-31 \
  --sources MODIS_SP --region pantanal --max-requests 10 --json
```

Observações:

- `--bbox` precisa de `=` quando as coordenadas começam com sinal de menos.
- `--region pantanal` usa um polígono de região configurado em vez de um bbox.
- O backfill legado usa blocos de 5 dias e as fontes `*_SP`. Ele não é mais usado
  pelo `bootstrap`; prefira o scraper de CSVs por país para dados históricos.
- `hotspots.geojson` exporta apenas os últimos `HOTSPOTS_EXPORT_MONTHS` (padrão 24)
  meses para manter o arquivo pequeno; o histórico completo fica no SQLite.

Teste rápido com fixtures sintéticas no formato do FIRMS:

```bash
node pipeline/src/cli.js pipeline \
  --input pipeline/fixtures \
  --out data/real \
  --json
```

## Ambiente

O worker carrega automaticamente o `.env` da raiz do projeto:

```dotenv
FIRMS_MAP_KEY=...
FIRMS_SOURCES=MODIS_NRT,VIIRS_NOAA20_NRT,VIIRS_NOAA21_NRT
NRT_REGIONS=pantanal,cerrado
NRT_DAYS=2
```

`FIRMS_MAP_KEY` é obrigatória apenas para a janela NRT atual e para o comando de
backfill legado. O processamento de CSVs históricos não precisa dela.

Configurações opcionais de banco:

```dotenv
FIRMS_DB_PATH=./data/db/firms.sqlite
FIRMS_COUNTRY=Brazil
FIRMS_HISTORY_START_YEAR=2000
HOTSPOTS_EXPORT_MONTHS=24
```

## Saídas

```text
data/db/firms.sqlite
data/raw/country/<source>/<year>_<country>.csv
data/runtime/country-download.json
data/runtime/import.json
data/real/calendario.json
data/real/hotspots.geojson
data/real/pontos-recentes.json
data/real/run-meta.json
```

O SQLite é a fonte de verdade histórica. `data/real` é regenerado a partir dele. O
arquivo legado `data/real/raw/hotspots.jsonl` ainda é gravado pelo comando
independente `npm run nrt`; não o apague se você depende desse caminho.

## Método dos dados

A calibração usa a mediana da razão `VIIRS/MODIS` por mês na janela de sobreposição,
encolhida em direção ao fator regional quando há poucas células disponíveis. A série
harmonizada é ancorada no MODIS; o VIIRS é dividido pelo fator quando é o único
sensor. Veja `docs/PIPELINE.md` para fórmulas e ressalvas.

## Observações

- As regiões padrão são os seis biomas brasileiros de `config/regions.json`.
- O SNPP é excluído das fontes NRT padrão após o encerramento dos dados em 2026; use
  NOAA-20/NOAA-21. Linhas históricas do SNPP ainda podem ser processadas a partir de
  arquivos.
- A API Nest em `src/` lê o conjunto de dados gerado em `data/real`.
