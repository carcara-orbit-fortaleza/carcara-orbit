# Fixtures

These CSVs are synthetic and exist only to smoke-test the pipeline and NRT merge
logic without NASA credentials or network access. They mimic the FIRMS Active
Fire CSV columns for MODIS and VIIRS.

Do not treat these values as real observations. For real work, download the
official files from NASA FIRMS/Earthdata and place them under `data/raw/`.

Smoke test:

```bash
node pipeline/src/cli.js pipeline --input pipeline/fixtures --out data/real --json
```

The pipeline will produce `data/real/calendario.json`,
`data/real/hotspots.geojson`, `data/real/pontos-recentes.json` and
`data/real/run-meta.json`.
