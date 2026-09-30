CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS polities (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  subjecto text,
  partof text
);

CREATE TABLE IF NOT EXISTS snapshots (
  id serial PRIMARY KEY,
  year integer NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS polity_geometries (
  polity_id integer NOT NULL REFERENCES polities(id) ON DELETE CASCADE,
  snapshot_id integer NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  border_precision smallint
);

CREATE INDEX IF NOT EXISTS polity_geometries_geom_idx
  ON polity_geometries USING gist (geom);
CREATE INDEX IF NOT EXISTS polity_geometries_snapshot_idx
  ON polity_geometries (snapshot_id);
