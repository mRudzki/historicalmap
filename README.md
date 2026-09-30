# Historia Europy na mapie

Kliknij punkt na mapie lub globusie Europy i zobacz, do jakiego państwa lub tworu
przedpaństwowego to miejsce należało. Suwak roku koloruje granice (każdy twór ma inny
kolor), a panel po kliknięciu pokazuje historię danego miejsca w czasie.

Projekt edukacyjny: granice są przybliżone.

## Szybki start

Wymagane: Docker, Node 24.

```bash
docker compose up -d --wait      # PostGIS, Martin (kafelki), API
scripts/fetch-data.sh            # pobiera dane Historical Basemaps do data/
npm install
npm run import                   # ładuje dane do bazy
npm run dev -w apps/web          # http://localhost:5174
```

Porty: baza `5433`, Martin `3100`, API `3001`, frontend `5174`
(zmienne `VITE_API_URL` i `VITE_TILES_URL` pozwalają je zmienić we frontendzie).

## Architektura

PostGIS przechowuje migawki granic. Martin streamuje kafelki wektorowe (MVT) z funkcji SQL
`polities_tile(z, x, y, year)`. Cienkie API (Fastify) odpowiada na zapytania
`/snapshots`, `/at?lat=&lon=&year=` i `/timeline?lat=&lon=`. Frontend (Vite + MapLibre GL,
projekcja globe) rysuje kafelki i panel.

## Testy

```bash
docker compose up -d --wait db
npm test                 # backend (Vitest + PostGIS) i logika frontendu
npm run typecheck
# e2e (wymaga uruchomionego stosu i zaimportowanych danych testowych):
DATA_DIR=db/fixtures npm run import
cd apps/web && npx playwright test
```

## Dane

Granice pochodzą z [Historical Basemaps](https://github.com/aourednik/historical-basemaps)
(GPL-3.0), autor: Andrew Ourednik. Dane nie są częścią repozytorium, pobiera je
`scripts/fetch-data.sh`. Autor zastrzega, że są przybliżone i w toku prac.

## Licencja

GPL-3.0 (patrz `LICENSE`).
