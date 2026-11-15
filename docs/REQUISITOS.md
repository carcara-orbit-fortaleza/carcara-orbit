# Adequação aos requisitos do desafio

Auditoria feita sobre o estado do monorepo após a integração de `api/` e `web/`,
a entrada do Postgres e a estrutura de CI/CD.

> **Escopo desta entrega:** infraestrutura, banco, CI/CD e verificação. Nenhuma
> alteração de layout foi feita em `web/`.

## Resumo executivo

| Tema | Situação |
| --- | --- |
| Harmonização MODIS × VIIRS | **Atendido no método** (calibração por célula/região, versão de método e pesos) |
| Calendário de queimadas 2000–presente | **Atendido no contrato**, dependente da carga de dados reais |
| Comparação com medianas históricas e anomalias | **Atendido** |
| Exportação CSV | **Atendido** (calendário, focos e GeoJSON da AOI) |
| Seleção de região e período | **Parcial** (regiões predefinidas, bbox na API, período limitado na UI) |
| Cores acessíveis | **Parcial** (rampas existentes, sem auditoria WCAG formal) |
| **Escopo global (histórico e solução)** | **Não atendido** (Brasil como padrão em dados, regiões e UI) |
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

**Parcial.**

- A API aceita `bbox=west,south,east,north`, `region`, `sensor`, `from` e `to`
  em `/api/hotspots` e `/api/export/hotspots.csv`.
- A web permite desenhar um polígono sobre o mapa e escolher entre regiões
  predefinidas; o calendário é filtrado pela interseção do polígono com os
  biomas.
- O calendário na UI oferece apenas “série completa” ou “últimos 10 anos”;
  não há seletor arbitrário de datas na interface.
- `/api/calendar` exige `region`; não existe calendário para uma bbox livre.

**Lacuna:** para uma AOI global arbitrária, falta um endpoint de calendário por
bbox/polígono e uma UI correspondente.

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

**Não atendido.**

Evidências do viés Brasil:

| Camada | Evidência |
| --- | --- |
| Pipeline | `FIRMS_COUNTRY=Brazil` é o padrão; o bootstrap baixa CSVs anuais por país |
| Regiões | `pipelines/config/regions.json` contém apenas os 6 biomas brasileiros |
| API | Datasets e calendários são por região predefinida; `/api/calendar` exige `region` |
| Web | `BRAZIL_BBOX = '-74,-34,-34,6'`; mapa centralizado em `[-14.5, -54]`; textos e globo citam Brasil |
| Dados | Importação histórica global não é automatizada; não há tabela/partição global nem tiles |

O que já é globalizável hoje:

- `FIRMS_COUNTRY` e `--country` permitem importar outro país (um por vez).
- `--bbox` do backfill aceita qualquer recorte suportado pela API FIRMS.
- `/api/hotspots` e a exportação de focos aceitam bbox livre.
- `REGIONS_FILE` (novo) permite apontar o pipeline para um GeoJSON de regiões
  próprio, sem alterar código.

O que falta para cumprir o requisito:

1. **Ingestão global**: definir uma fonte global (FIRMS archive/tiles ou
   partições por país) e um job de carga idempotente, com checkpoint.
2. **Modelo global**: substituir “biomas do Brasil” por uma grade global
   (ex.: células de 0,5° ou 1°) e/ou regiões administrativas, com PostGIS.
3. **Consultas por AOI**: calendário e métricas para bbox/polígono arbitrários,
   não só para regiões predefinidas.
4. **UI global**: mapa-múndi, busca por coordenadas e seletor de país/região —
   depende de mudança de layout, fora do escopo desta entrega.
5. **Operação**: migrar a série analítica de SQLite para Postgres/PostGIS e
   definir retenção, índices e partições.

### 8. Dados reais e operação em produção

**Parcial.**

- Existe pipeline de dados reais (histórico + NRT), scheduler e endpoints de
  status/trigger.
- O SQLite histórico (`data/db/firms.sqlite`) e os JSONs em `data/real/` são
  persistentes no volume `api_data`.
- Postgres foi adicionado para saúde, migrações e histórico operacional
  (`operation_runs`, exposto em `/api/runs`, protegido por `ADMIN_TOKEN` quando
  configurado), com backup diário em produção.
- A série analítica **ainda não está no Postgres**; essa migração é o próximo
  passo para escala global e múltiplas réplicas.

### 9. Autenticação do painel

**Não é requisito do desafio, mas é uma lacuna funcional do produto.**

A web chama `/api/auth/login`, `/api/auth/me` e `/api/auth/logout`, mas a API
atual não possui módulo de autenticação. O painel abre a tela de login e não
consegue autenticar. Isso já existia antes desta entrega e não foi alterado.

### 10. Testes e qualidade

**Atendido no que existe.**

- 10 testes unitários da API (`npm test`).
- 24 testes do pipeline (`npm run pipeline:test`).
- 13 casos e2e (`npm run test:e2e`), incluindo modo real e exportações.
- CI executa lint dos dois apps, build, testes unitários, testes do pipeline,
  e2e, migrações em Postgres, smoke test da API e build das imagens Docker.

## Roadmap sugerido (ordem de impacto)

1. **PostGIS + grade global**: migrar hotspots/clusters para Postgres, com
   partições por ano e índices espaciais; importar a série global.
2. **API por AOI**: `GET /api/calendar?bbox=...` e métricas calculadas por
   bbox/polígono, reutilizando a mesma base harmonizada.
3. **Ingestão global resiliente**: job de carga com checkpoint, retomada e
   validação de cobertura por país/região.
4. **UI global** (quando houver autorização para alterar layout): mapa-múndi,
   busca por coordenadas, seletor de período livre.
5. **Autenticação real** do painel (ou remoção da tela de login enquanto não
   houver backend de auth).

## Conclusão

O projeto atende bem ao núcleo metodológico do desafio — harmonização,
calendário, anomalias e exportação — e agora tem base de produção com Postgres,
backup e CI/CD. **O requisito de escopo global ainda não está atendido**: o
sistema é configurável para outros recortes, mas a experiência, os dados padrão,
as regiões e a interface continuam centrados no Brasil.
