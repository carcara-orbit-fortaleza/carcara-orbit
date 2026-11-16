**English** · [Português](README.pt-BR.md)

# Carcará Orbit web

React 19 + Vite 7 + Tailwind 4 single-page app for the public site and the fire
monitoring dashboard.

## Routes

| Route | Description |
| --- | --- |
| `/` | Public site with the 3D globe and recent hotspots |
| `/dashboard` | Global dashboard: calendar, anomalies, 3D map, chance grid, risk calculator and CSV/AOI exports |

## Data

The dashboard consumes the global API track:

- `GET /api/global/aggregates` — every 10° grid cell with yearly/monthly
  harmonized, MODIS and VIIRS matrices; loaded once and used for the calendar,
  anomalies, chips and AOI;
- `GET /api/global/hotspots` — recent hotspot sample for the map and globe;
- `GET /api/health` — availability check.

The legacy Brazil endpoints (`/api/hotspots`, `/api/regions`, `/api/calendar`)
remain available for the Brazil track.

## Map and Content Security Policy

The 3D map uses MapLibre with:

- Esri World Imagery raster tiles from `https://server.arcgisonline.com`;
- Mapzen/AWS terrain tiles from `https://s3.amazonaws.com`.

MapLibre fetches raster and terrain tiles with `fetch`, so nginx must allow both
hosts in `connect-src` and `img-src`, and allow the MapLibre blob worker with
`worker-src 'self' blob:`. The policy lives in [`nginx.conf`](nginx.conf). If you
add a new tile provider, update the CSP as well.

## Development

```bash
npm ci
npm run dev      # http://localhost:5173
```

`VITE_API_URL` defaults to `http://localhost:3000/api`. The production build uses
`VITE_API_URL=/api`, so the browser calls the same origin and nginx proxies
`/api` to the API service.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Vite development server |
| `npm run build` | Type-check (`tsc -b`) and build the production bundle |
| `npm run preview` | Preview the production build |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit tests |

## Accessibility

The dashboard uses color ramps with legends and data tables, but it has no formal
WCAG audit yet. See [`../docs/REQUISITOS.md`](../docs/REQUISITOS.md) for the
current status and roadmap.

## More docs

- [`../README.md`](../README.md) — monorepo overview.
- [`../docs/GLOBAL.md`](../docs/GLOBAL.md) — global aggregate and endpoints.
- [`../docs/DEPLOY.md`](../docs/DEPLOY.md) — production deploy and CSP notes.
