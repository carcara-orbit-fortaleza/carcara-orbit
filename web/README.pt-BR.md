[English](README.md) · **Português**

# Web do Carcará Orbit

Aplicação de página única em React 19 + Vite 7 + Tailwind 4 para o site público e
o painel de monitoramento de incêndios.

## Rotas

| Rota | Descrição |
| --- | --- |
| `/` | Site público com o globo 3D e focos recentes |
| `/dashboard` | Painel global: calendário, anomalias, mapa 3D, grid de probabilidade, calculadora de risco e exportações CSV/AOI |

## Dados

O painel consome a trilha global da API:

- `GET /api/global/aggregates` — cada célula do grid de 10° com matrizes anuais e
  mensais harmonizadas, do MODIS e do VIIRS; carregada uma vez e usada para o
  calendário, as anomalias, os chips e a AOI;
- `GET /api/global/hotspots` — amostra de focos recentes para o mapa e o globo;
- `GET /api/health` — verificação de disponibilidade.

Os endpoints legados do Brasil (`/api/hotspots`, `/api/regions`, `/api/calendar`)
continuam disponíveis para a trilha do Brasil.

## Mapa e Content Security Policy

O mapa 3D usa MapLibre com:

- tiles raster do Esri World Imagery de `https://server.arcgisonline.com`;
- tiles de terreno do Mapzen/AWS de `https://s3.amazonaws.com`.

O MapLibre busca tiles raster e de terreno com `fetch`, então o nginx precisa
permitir ambos os hosts em `connect-src` e `img-src`, e permitir o worker blob do
MapLibre com `worker-src 'self' blob:`. A política fica em [`nginx.conf`](nginx.conf).
Se você adicionar um novo provedor de tiles, atualize também a CSP.

## Desenvolvimento

```bash
npm ci
npm run dev      # http://localhost:5173
```

`VITE_API_URL` tem como padrão `http://localhost:3000/api`. O build de produção usa
`VITE_API_URL=/api`, então o navegador chama a mesma origem e o nginx faz proxy de
`/api` para o serviço da API.

## Scripts

| Comando | Descrição |
| --- | --- |
| `npm run dev` | Servidor de desenvolvimento do Vite |
| `npm run build` | Verificação de tipos (`tsc -b`) e build do bundle de produção |
| `npm run preview` | Pré-visualiza o build de produção |
| `npm run lint` | ESLint |
| `npm test` | Testes unitários com Vitest |

## Acessibilidade

O painel usa rampas de cores com legendas e tabelas de dados, mas ainda não tem
auditoria formal de WCAG. Veja [`../docs/REQUISITOS.pt-BR.md`](../docs/REQUISITOS.pt-BR.md) para
o estado atual e o roadmap.

## Mais documentação

- [`../README.pt-BR.md`](../README.pt-BR.md) — visão geral do monorepo.
- [`../docs/GLOBAL.pt-BR.md`](../docs/GLOBAL.pt-BR.md) — agregado global e endpoints.
- [`../docs/DEPLOY.pt-BR.md`](../docs/DEPLOY.pt-BR.md) — deploy de produção e notas de CSP.
