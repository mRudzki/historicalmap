# Historical Europe Map — design

## Cel

Publiczne repo (GPL-3.0). Użytkownik klika punkt na mapie/globusie Europy i widzi, do jakiego państwa lub tworu przedpaństwowego to miejsce należało. Cel edukacyjny: liczy się czytelna wizualizacja, dokładność „mniej więcej" jest akceptowalna. Możliwa późniejsza monetyzacja reklamami (poza zakresem v1).

## Wymagania

- Suwak roku koloruje mapę: granica każdego tworu ma inny, stały kolor.
- Klik w punkt pokazuje oś czasu tego miejsca (kolejne twory i lata) oraz twór z wybranego roku.
- Widok mapy i globusa (MapLibre GL, projekcja globe).
- Dane w lokalnej bazie (PostGIS), kafelki streamowane z bazy (MVT), nie ładujemy całych granic naraz.
- Wiele tworów w jednym punkcie jest dozwolone (przed 1648 r. terytoria się nakładają).

## Źródło danych

Główne: **Historical Basemaps** (aourednik, GPL-3.0, GeoJSON, WGS84, migawki w czasie; atrybuty `NAME`, `SUBJECTO`, `PARTOF`, `BORDERPRECISION`). Dane nie są w repo, pobiera je skrypt importu. Atrybucja w README i w stopce mapy.

Odrzucone: CShapes (licencja NC, tylko od 1816/1886, tylko państwa), GeaCron (brak eksportu poligonów). Później opcjonalnie OpenHistoricalMap (CC BY-SA 2.0, ciągłe daty), model danych ma to umożliwiać.

Ograniczenia źródła: granice przybliżone (skala świata/kontynentu), migawki zamiast ciągłych dat. UI pokazuje rok migawki, która jest aktualnie widoczna.

## Architektura (Docker Compose)

1. **PostGIS** — baza historyczna.
2. **Martin** — kafelki MVT z funkcji SQL `polities_tile(z, x, y, year)`; filtruje geometrie ważne w danym roku, zwraca `id`, `name`, `precision`. Cache'owalne po `(z,x,y,year)`.
3. **API** (TypeScript, Fastify):
   - `GET /at?lat=&lon=&year=` — twory obejmujące punkt w danym roku (lista).
   - `GET /timeline?lat=&lon=` — `[{name, from, to}]` dla punktu, złożone z kolejnych migawek.
4. **Frontend** (Vite + TypeScript + MapLibre GL): suwak roku, kolor z hasha nazwy, panel osi czasu po kliknięciu.

## Model danych

- `polities(id, name, subjecto, partof)`
- `snapshots(id, year)`
- `polity_geometries(polity_id, snapshot_id, geom, border_precision)`, indeks GiST na `geom`.

Geometria ze snapshotu Y obowiązuje do następnego snapshotu; zapytanie o rok bierze najbliższą migawkę nie późniejszą niż rok. Rozszerzenie pod OHM: kolumny `valid_from`/`valid_to`.

Import (CLI) jest idempotentny: czyści i ładuje snapshoty w jednej transakcji.

## Błędy

- `/at`, `/timeline`: walidacja `lat` (−90..90), `lon` (−180..180), `year` (zakres migawek); złe dane → 400.
- Punkt poza danymi (morze, poza Europą) → 200 z pustą listą; UI: „brak danych dla tego miejsca w tym roku".
- Martin zwraca pusty kafelek bez geometrii; błąd sieci → dyskretny komunikat, można kliknąć ponownie.

## Testy

- Integracyjne na PostGIS w kontenerze z małym fixture (2–3 poligony, 2 migawki): `polities_tile`, zapytania punktowe, granica między migawkami, nakładające się twory.
- API: Fastify `inject` na tej samej bazie, w tym walidacja wejścia.
- Frontend: testy jednostkowe czystej logiki (kolor z hasha, wybór roku migawki); jeden smoke test Playwright (załaduj, kliknij, sprawdź panel).
- CI: GitHub Actions — lint, testy, build.

## Struktura repo

```
/apps/api        Fastify: /at, /timeline
/apps/web        Vite + MapLibre
/db              schemat SQL, polities_tile, fixture
/scripts         import.ts (Historical Basemaps -> PostGIS)
/docker-compose.yml
/LICENSE         GPL-3.0
/README.md       uruchomienie, źródła danych, atrybucja
```

## Poza zakresem v1 (YAGNI)

Reklamy, OpenHistoricalMap jako drugie źródło, wyszukiwarka miejsc, konta użytkowników, tłumaczenia interfejsu.
