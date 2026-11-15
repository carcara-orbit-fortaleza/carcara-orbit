# Adequação aos requisitos do desafio

Auditoria feita sobre o estado do monorepo após a integração de `api/` e `web/`,
a entrada do Postgres e a estrutura de CI/CD.

> **Escopo desta entrega:** infraestrutura, banco, CI/CD, ingestão global na API
> e verificação. Nenhuma alteração de layout foi feita em `web/`.

## Resumo executivo

| Tema | Situação |
| --- | --- |
| Harmonização MODIS × VIIRS | **Atendido no método** (calibração por célula/região, versão de método e pesos) |
| Calendário de queimadas 2000–presente | **Atendido no contrato**, dependente da carga de dados reais |
| Comparação com medianas históricas e anomalias | **Atendido** |
| Exportação CSV | **Atendido** (calendário, focos e GeoJSON da AOI) |
| Seleção de região e período | **Parcial** (regiões predefinidas, bbox na API, período limitado na UI) |
| Cores acessíveis | **Parcial** (rampas existentes, sem auditoria WCAG formal) |
| **Escopo global (histórico e solução)** | **Atendido na API**; web ainda Brasil (sem alteração de layout) e carga global é operacional |
| Produção: Postgres, backup, health | **Atendido na infraestrutura**; série analítica ainda em SQLite |
| CI/CD com deploy em VPS | **Atendido** (workflow + runbook) |

## Matriz de requisitos

### 1. Harmonizar MODIS e VIIRS em uma série consistente

**Atendido no pipeline.**

- `api/pipeline/src/pipeline/calibrate.js` calcula fatores de calibração
  VIIRS/MODIS por célula, região, mês e período diurno/noturno, com shrinkage e
  limites de segurança.
- `api/pipeline/src/pipeline/aggregate.js` agrega detecções em clusters,
  preserva `has_modis`/`has_viirs`, sensores, plataformas e fatores por região.
- `api/src/hotspots/hotspots.service.ts` expõe `harmonized_weight`,
  `method_version` e a contagem harmonizada por cluster.
- A calibração é explícita e versionada (`h1.0`), o que permite reprocessar a
  série quando o método mudar.

**Ressalva:** o método está implementado, mas a qualidade final depende de uma
carga histórica completa (ver item 8).

### 2. Calendário de atividade de queimadas do início dos anos 2000 até hoje

**Atendido no contrato; parcial nos dados da instância.**

- O pipeline aceita `FIRMS_HISTORY_START_YEAR` (padrão `2000`) e
  `BASELINE_START_YEAR`/`BASELINE_END_YEAR` (2003–2025).
- `GET /api/calendar?region=&from=&to=` devolve matriz ano × mês, contagens
  brutas MODIS/VIIRS, contagens harmonizadas e anomalias.
- O dataset mock cobre 2000-01 a 2026-10 com 12 meses e 6 regiões.
- O modo real é gerado por `npm run bootstrap`, `npm run pipeline` ou
  `npm run nrt` e fica em `data/real/`.

**Ressalva:** a instância de produção só atende o requisito depois de executar
a carga histórica. O repositório não versiona os CSVs baixados nem o SQLite
(ambos ignorados pelo Git).

### 3. Selecionar uma área de interesse e um intervalo de datas

**Parcial (backend global completo; UI limitada).**

- A API aceita `bbox=west,south,east,north`, `region`, `sensor`, `from` e `to`
  em `/api/hotspots` e `/api/export/hotspots.csv`.
- `GET /api/global/calendar` e `/api/global/hotspots` aceitam **qualquer bbox
  do mundo** ou uma célula da grade, resolvendo a limitação do dataset Brasil.
- A web permite desenhar um polígono sobre o mapa e escolher entre regiões
  predefinidas; o calendário é filtrado pela interseção do polígono com os
  biomas.
- O calendário na UI oferece apenas “série completa” ou “últimos 10 anos”;
  não há seletor arbitrário de datas na interface.
- `/api/calendar` (dataset Brasil) exige `region`; o equivalente global não.

**Lacuna:** a UI ainda não consome os endpoints globais nem oferece seletor
livre de período; isso depende de mudança de layout, que não foi feita.

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

**Atendido na API; parcial na experiência.**

A ingestão global foi implementada como uma trilha separada do dataset Brasil,
sem alterar `web/`:

| Camada | Implementação |
| --- | --- |
| Fonte histórica | Índice mundial `FIRMS` por país: 238 países, 10.095 CSVs, 2000–2025, ~43,5 GB |
| Banco | `data/db/global.sqlite`, separado do `firms.sqlite` do Brasil |
| Modelo | Grade mundial de 10° (648 células), configurável de 5° a 60°, com IDs, polígonos e centros |
| Atribuição | `gridRegionAt()` resolve a célula por latitude/longitude sem varrer polígonos |
| Clusters/calibração | Mesmos algoritmos do Brasil, com fatores VIIRS/MODIS por célula e mês |
| NRT | `--current` consulta a janela atual em tiles globais (30° por padrão) |
| API | `/api/global/status`, `/regions`, `/calendar`, `/hotspots`, exports e ingestão em background |
| Operação | Checkpoints de download/importação, retomada, log e registro em `operation_runs` |

Recursos disponíveis globalmente:

- `POST /api/global/ingest` dispara a carga histórica mundial ou um piloto
  (`maxFiles`, `maxImportFiles`, `dryRun`).
- `GET /api/global/calendar?region=g_...` ou `?bbox=...` devolve o calendário
  harmonizado para qualquer célula ou área do planeta.
- `GET /api/global/hotspots?bbox=...` e os exports CSV atendem qualquer AOI.
- `POST /api/global/ingest` com `includeCurrent=true` atualiza o ano corrente
  pela API NRT.

Limitações que permanecem:

1. **Web**: a interface continua com `BRAZIL_BBOX`, mapa centrado no Brasil e
   seis biomas. Por instrução, nenhuma alteração de layout foi feita.
2. **Dados**: a carga global não roda automaticamente no deploy; a operação
   precisa executar o job (dezenas de GB) e acompanhar `/api/global/status`.
3. **Escala**: a série analítica ainda está em SQLite; para consultas
   concorrentes/particionadas em escala global, o próximo passo é PostGIS.
4. **Cobertura**: o índice histórico cobre MODIS, VIIRS S-NPP e JPSS1/NOAA-20;
   NOAA-21 entra via NRT.

O runbook está em [`GLOBAL.md`](./GLOBAL.md).

### 8. Dados reais e operação em produção

**Parcial.**

- Existe pipeline de dados reais (histórico + NRT), scheduler e endpoints de
  status/trigger.
- O SQLite histórico (`data/db/firms.sqlite`) e os JSONs em `data/real/` são
  persistentes no volume `api_data`.
- Postgres foi adicionado para saúde, migrações e histórico operacional
  (`operation_runs`, exposto em `/api/runs`, protegido por `ADMIN_TOKEN` quando
  configurado), com backup diário em produção.
- A ingestão global grava em `data/db/global.sqlite`, persistido no volume
  `api_data`, e registra o job no Postgres.
- A série analítica **ainda não está no Postgres**; essa migração é o próximo
  passo para escala global e múltiplas réplicas.

### 9. Autenticação do painel

**Não é requisito do desafio, mas é uma lacuna funcional do produto.**

A web chama `/api/auth/login`, `/api/auth/me` e `/api/auth/logout`, mas a API
atual não possui módulo de autenticação. O painel abre a tela de login e não
consegue autenticar. Isso já existia antes desta entrega e não foi alterado.

### 10. Testes e qualidade

**Atendido no que existe.**

- 14 testes unitários da API (`npm test`), incluindo a grade e consultas globais.
- 30 testes do pipeline (`npm run pipeline:test`), incluindo ingestão global e NRT por tiles.
- 15 casos e2e (`npm run test:e2e`), incluindo modo real, exportações e endpoints globais.
- CI executa lint dos dois apps, build, testes unitários, testes do pipeline,
  e2e, migrações em Postgres, smoke test da API e build das imagens Docker.

## Roadmap sugerido (ordem de impacto)

1. **Carga global operacional**: executar o job mundial na VPS em piloto, validar
   cobertura por país e acompanhar disco/tempo; hoje a API está pronta, mas os
   dados não são carregados automaticamente.
2. **PostGIS + partições**: migrar hotspots/clusters globais para Postgres, com
   índices espaciais e partições por ano, para consultas concorrentes em escala.
3. **UI global** (quando houver autorização para alterar layout): mapa-múndi,
   busca por coordenadas, seletor de período livre e uso dos endpoints globais.
4. **Autenticação real** do painel (ou remoção da tela de login enquanto não
   houver backend de auth).

## Conclusão

O projeto atende ao núcleo metodológico do desafio — harmonização, calendário,
anomalias e exportação — e agora tem base de produção com Postgres, backup,
CI/CD e uma trilha de ingestão global na API. O escopo global está **atendido no
backend** (histórico mundial por país, grade, calibração e consultas por AOI);
o que falta é operacionalizar a carga completa e, quando permitido, expor essa
capacidade na interface. A web permanece intencionalmente inalterada nesta
entrega.
