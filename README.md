# Carcará Orbit

Monorepo do Carcará Orbit: painel e API de monitoramento de focos de calor no Brasil.

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
Dockerfiles multi-stage e, em produção, Traefik + nginx servindo a SPA e fazendo proxy de `/api`.

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
# edite .env se necessário (FIRMS_MAP_KEY, portas, etc.)
docker compose up --build
```

| Serviço | URL |
| --- | --- |
| Web | http://localhost:5173 |
| API (health) | http://localhost:3000/api/health |
| API (meta) | http://localhost:3000/api/meta |

O Compose de desenvolvimento usa bind mount e hot reload nos dois serviços.
Por padrão a API sobe em `DATA_SOURCE=mock`, com os dados de `api/data/mock`.

### Dados reais (NASA FIRMS)

1. Obtenha uma `FIRMS_MAP_KEY` em <https://firms.modaps.eosdis.nasa.gov/api/map_key/>.
2. Preencha `FIRMS_MAP_KEY` no `.env`.
3. Para o modo real, defina `DATA_SOURCE=real` ou use
   `docker compose exec api npm run bootstrap` para baixar/importar o histórico.

O diretório `api/data` é o volume de trabalho do pipeline (`raw`, `real`, `db`,
`runtime`) e é persistido no volume `api_data` em produção. Detalhes em
[`api/docs/REAL-DATA.md`](./api/docs/REAL-DATA.md) e
[`api/pipeline/docs/PIPELINE.md`](./api/pipeline/docs/PIPELINE.md).

## Produção

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env up -d --build
```

Antes de subir:

- aponte o DNS de `APP_HOST` para o servidor;
- defina `APP_HOST` e `ADMIN_EMAIL` no `.env` (Traefik/Let's Encrypt);
- libere as portas `80` e `443`.

O Traefik termina o TLS e encaminha para o nginx do `web`. O nginx serve os assets
da SPA e faz proxy de `/api` para o serviço `api`, que permanece inacessível
diretamente pela internet.

## Desenvolvimento sem Docker

```bash
# API
cd api
npm ci
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
| `docker compose exec api npm run bootstrap` | Baixa/importa o histórico FIRMS |
| `docker compose exec api npm run pipeline` | Roda o pipeline histórico |
| `docker compose exec api npm test` | Testes unitários da API |
| `docker compose exec web npm run lint` | Lint do front |

## Licença

Projeto privado da Carcará Orbit Fortaleza.
