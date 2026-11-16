[English](README.md) · **Português**

# Fixtures

Estes CSVs são sintéticos e existem apenas para teste rápido (smoke test) do
pipeline e da lógica de merge do NRT sem credenciais da NASA nem acesso à rede.
Eles imitam as colunas do FIRMS Active Fire CSV para MODIS e VIIRS.

Não trate esses valores como observações reais. Para trabalho real, baixe os
arquivos oficiais do NASA FIRMS/Earthdata e coloque-os em `data/raw/`.

Teste rápido:

```bash
node pipeline/src/cli.js pipeline --input pipeline/fixtures --out data/real --json
```

O pipeline produzirá `data/real/calendario.json`,
`data/real/hotspots.geojson`, `data/real/pontos-recentes.json` e
`data/real/run-meta.json`.
