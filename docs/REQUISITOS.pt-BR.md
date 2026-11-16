[English](REQUISITOS.md) · **Português**

# Adequação aos requisitos do desafio

Auditoria do monorepo após a integração de `api/` e `web/`, a entrada do
Postgres e a estrutura de CI/CD.

> **Escopo desta entrega:** infraestrutura, banco, CI/CD, ingestão global da API,
> agregado global e integração do painel.

## Resumo executivo

| Tema | Situação |
| --- | --- |
| Harmonização MODIS × VIIRS | **Atendido no método** (calibração por célula/região, versão de método e pesos) |
| Calendário de queimadas 2000–presente | **Atendido** (agregado histórico 2000–2025 + camada do ano corrente via FIRMS) |
| Comparação com medianas históricas e anomalias | **Atendido** |
| Exportação CSV | **Atendido** (calendário, focos e GeoJSON da AOI) |
| Seleção de região e período | **Atendido para região/AOI**; o seletor de período ainda é série completa/10 anos |
| Cores acessíveis | **Parcial** (rampas existentes, sem auditoria WCAG formal) |
| **Escopo global (histórico e solução)** | **Atendido na API e no painel**; a carga global é operacional |
| Produção: Postgres, backup, health | **Atendido na infraestrutura**; a série analítica segue em SQLite/volume |
| CI/CD com deploy em VPS | **Atendido** (workflow + runbook) |

## Matriz de requisitos

### 1. Harmonizar MODIS e VIIRS em uma série consistente

**Atendido no pipeline e no agregado global.**

- `api/pipeline/src/pipeline/calibrate.js` calcula fatores de calibração
  VIIRS/MODIS por célula, região, mês e período diurno/noturno, com shrinkage e
  limites de segurança.
- `api/pipeline/src/pipeline/aggregate.js` agrega detecções em clusters e
  preserva `has_modis`/`has_viirs`, sensores, plataformas e fatores por região.
- `api/scripts/global_aggregate.py` calcula fatores por célula/mês para a grade
  global e grava contagens MODIS, VIIRS, brutas e harmonizadas.
- `api/src/hotspots/hotspots.service.ts` expõe `harmonized_weight`,
  `method_version` e a contagem harmonizada por cluster.
- A calibração é explícita e versionada (`h1.0`), o que permite reprocessar a
  série quando o método mudar.

**Ressalva:** o método está implementado; a qualidade final depende da carga de
dados e da janela de calibração (2012–2025).

### 2. Calendário de atividade de queimadas do início dos anos 2000 até hoje

**Atendido.**

- O pipeline aceita `FIRMS_HISTORY_START_YEAR` (padrão `2000`) e
  `BASELINE_START_YEAR`/`BASELINE_END_YEAR` (2003–2025).
- `GET /api/calendar?region=&from=&to=` devolve a matriz ano × mês, contagens
  brutas MODIS/VIIRS, contagens harmonizadas e anomalias.
- `GET /api/global/aggregates` devolve as matrizes harmonizadas de todas as
  células globais, de 2000 até o ano corrente.
- `api/scripts/fetch_current_year.py` preenche o ano aberto (2026) pela API Area
  do FIRMS; o agregado lê a camada em `data/raw/global/current/`.
- O dataset mock cobre 2000-01 a 2026-10 com 12 meses e 6 regiões.
- O modo real é gerado por `npm run bootstrap`, `npm run pipeline` ou
  `npm run nrt` e fica em `data/real/`.

**Ressalva:** o ano corrente é uma camada ano-até-agora; ela é substituída
quando o arquivo anual por país daquele ano estiver disponível.

### 3. Selecionar uma área de interesse e um intervalo de datas

**Atendido para AOI; parcial para datas arbitrárias.**

- A API aceita `bbox=west,south,east,north`, `region`, `sensor`, `from` e `to`
  em `/api/hotspots` e `/api/export/hotspots.csv`.
- `GET /api/global/calendar` e `/api/global/hotspots` aceitam **qualquer bbox do
  mundo** ou uma célula da grade.
- O painel permite desenhar um polígono sobre o mapa 3D e escolher entre regiões
  predefinidas; o calendário é filtrado pela interseção do polígono e usa a
  grade completa de 648 células.
- O seletor de período do painel ainda oferece apenas “série completa” ou
  “últimos 10 anos”; não há seletor livre de datas na interface.
- `/api/calendar` (dataset Brasil) exige `region`; o equivalente global não.

**Lacuna:** seletor de intervalo de datas na UI.

### 4. Comparar o período atual com medianas históricas e anomalias

**Atendido.**

- O pipeline gera `anomaly_pct` por ano/mês e `metrics` por região, incluindo
  média de baseline, pico histórico, tendência por década e total do ano
  corrente.
- A web exibe anomalia do ano corrente, pico histórico, série anual,
  climatologia mensal e calendário com rampa de anomalia.
- O baseline e o período são explícitos nos metadados (`h1.0`, 2003–2025).

### 5. Exportar os resultados da busca

**Atendido.**

- `GET /api/export.csv?region=&from=&to=` exporta o calendário.
- `GET /api/export/hotspots.csv?region=&from=&to=&sensor=&bbox=` exporta os
  focos filtrados.
- A web gera CSV do calendário, CSV dos focos visíveis e GeoJSON da AOI.
- Arquivos usam BOM e `;` para compatibilidade com Excel em pt-BR.

### 6. Visualização acessível e intuitiva

**Parcial.**

- Existem rampas de cor para contagem e anomalia (`web/src/painel/lib/colors.ts`),
  legenda e tabela de dados com `<caption>`.
- Não há auditoria formal de contraste/WCAG, teste com leitores de tela ou
  alternativa textual completa para todos os gráficos.

### 7. Escopo global (requisito explícito desta revisão)

**Atendido na API e no painel.**

A trilha global é separada do dataset Brasil:

| Camada | Implementação |
| --- | --- |
| Fonte histórica | Índice mundial FIRMS por país: 238 países, 10.095 CSVs, 2000–2025, ~43,5 GB |
| Ano corrente | API Area do FIRMS, blocos de 5 dias no mundo (SP + NRT), `data/raw/global/current/` |
| Banco analítico | `data/db/aggregates.sqlite` (célula × ano × mês × sensor, calibração, amostra recente) |
| Modelo | Grade mundial de 10° (648 células), configurável de 5° a 60°, com IDs, polígonos e centros |
| Atribuição | `gridRegionAt()` resolve a célula por latitude/longitude sem varrer polígonos |
| Calibração | Fatores VIIRS/MODIS por célula e mês |
| Banco legado | `data/db/global.sqlite`, separado do `firms.sqlite` do Brasil |
| NRT | `--current` busca a janela atual em tiles globais (30° por padrão) |
| API | `/api/global/status`, `/aggregates`, `/regions`, `/calendar`, `/hotspots`, exports e ingestão em background |
| Painel | Mapa 3D, calendário global, gráficos de anomalia/climatologia, polígono de AOI e exportação CSV |
| Operação | Checkpoints de download/importação, retomada, logs e registro em `operation_runs` |

Recursos globais:

- `POST /api/global/ingest` dispara a carga histórica mundial ou um piloto
  (`maxFiles`, `maxImportFiles`, `dryRun`).
- `GET /api/global/aggregates` devolve as matrizes harmonizadas de todas as
  células; o painel usa as 24 mais ativas nos chips/calculadora e a grade
  completa para AOI.
- `GET /api/global/calendar?region=g_...` ou `?bbox=...` devolve o calendário
  harmonizado para qualquer célula ou área.
- `GET /api/global/hotspots?bbox=...` e os exports CSV atendem qualquer AOI.
- `api/scripts/fetch_current_year.py` preenche o ano aberto pela API do FIRMS.

Limitações que permanecem:

1. **Seletor de período:** a UI ainda oferece apenas série completa/10 anos.
2. **Atualização:** a carga global e o job do ano corrente não rodam
   automaticamente no deploy; o operador executa e acompanha
   `/api/global/status`.
3. **Escala:** a série analítica segue em SQLite; consultas concorrentes e
   particionadas em escala global são o próximo passo (PostGIS).
4. **Cobertura:** o índice histórico inclui MODIS, VIIRS S-NPP e JPSS1/NOAA-20;
   NOAA-21 entra via NRT e pela camada do ano corrente.

O runbook está em [`GLOBAL.pt-BR.md`](./GLOBAL.pt-BR.md).

### 8. Dados reais e operação em produção

**Atendido para a arquitetura atual.**

- Existe pipeline de dados reais (histórico + NRT), com scheduler e endpoints de
  status/trigger.
- O SQLite histórico (`data/db/firms.sqlite`) e os JSONs em `data/real/` são
  persistentes no volume `api_data`.
- O Postgres guarda saúde, migrações e histórico operacional (`operation_runs`,
  exposto em `/api/runs`, protegido por `ADMIN_TOKEN` quando configurado), com
  backup diário em produção.
- O agregado global é servido de `data/db/aggregates.sqlite`, persistido no
  volume `api_data`; a ingestão linha a linha legada ainda grava
  `data/db/global.sqlite` e registra o job no Postgres.
- A série analítica **ainda não está no Postgres**; essa migração é o próximo
  passo para escala global e múltiplas réplicas.

### 9. Autenticação do painel

**Não é requisito do desafio, mas é uma lacuna funcional do produto.**

A web chama `/api/auth/login`, `/api/auth/me` e `/api/auth/logout`, mas a API
atual não possui módulo de autenticação. O painel abre a tela de login e não
consegue autenticar. Isso já existia antes desta entrega e não foi alterado.

### 10. Testes e qualidade

**Atendido no que existe.**

- Testes unitários da API (`npm test`): 48 testes, incluindo grade, consultas
  globais e o contrato do agregado.
- Testes unitários da web (`npm test`): 87 testes.
- Testes do pipeline (`npm run pipeline:test`) e e2e (`npm run test:e2e`) rodam
  no CI.
- O CI executa lint dos dois apps, build, testes unitários, testes do pipeline,
  e2e, migrações em Postgres, smoke test da API e build das imagens Docker.

## Roadmap sugerido (ordem de impacto)

1. **Atualização global agendada**: rodar o job do ano corrente e o agregado em
   um cron/systemd timer e alertar em falhas.
2. **PostGIS + partições**: migrar hotspots/clusters globais para Postgres, com
   índices espaciais e partições anuais, para consultas concorrentes em escala.
3. **Seletor de período**: adicionar um seletor livre de intervalo de datas ao
   painel.
4. **Autenticação real** do painel (ou remoção da tela de login enquanto não
   houver backend de auth).

## Conclusão

O projeto atende ao núcleo metodológico do desafio — harmonização, calendário,
anomalias e exportação — e agora tem base de produção com Postgres, backups,
CI/CD e uma trilha global operacional. O escopo global está **atendido no
backend e no painel**: histórico mundial, grade, calibração, consultas por AOI e
dados do ano corrente pela API do FIRMS.
