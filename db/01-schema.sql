CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS polities (
  id serial PRIMARY KEY,
  name text NOT NULL,
  admin_level smallint NOT NULL DEFAULT 2,
  UNIQUE (name, admin_level)
);

CREATE TABLE IF NOT EXISTS polity_geometries (
  polity_id integer NOT NULL REFERENCES polities(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('ohm', 'hb')),
  valid_from double precision NOT NULL,
  valid_to double precision,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  border_precision smallint,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- Simplified copy (see simplify_polygons) so /history can union states quickly.
ALTER TABLE polity_geometries ADD COLUMN IF NOT EXISTS geom_simple geometry(MultiPolygon, 4326);

CREATE INDEX IF NOT EXISTS polity_geometries_geom_idx
  ON polity_geometries USING gist (geom);
CREATE INDEX IF NOT EXISTS polity_geometries_time_idx
  ON polity_geometries (source, valid_from, valid_to);
