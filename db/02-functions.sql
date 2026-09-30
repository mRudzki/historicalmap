DROP FUNCTION IF EXISTS snapshot_for_year(integer);

-- Valid, simplified (0.02 degrees) MultiPolygon; the input itself if simplification leaves nothing.
CREATE OR REPLACE FUNCTION simplify_polygons(geom geometry) RETURNS geometry
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN ST_IsEmpty(s) THEN geom ELSE s END
  FROM (SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SimplifyPreserveTopology(geom, 0.02)), 3)) AS s) x
$$;

CREATE OR REPLACE FUNCTION polity_color(polity_name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN polity_name = 'Unnamed territory' THEN 'hsl(0, 0%, 80%)'
    ELSE 'hsl(' ||
      (('x' || substr(md5(polity_name), 1, 7))::bit(28)::int % 360) || ', 55%, 60%)'
  END
$$;

DROP FUNCTION IF EXISTS polity_tile_layer(text, text, integer, integer, double precision, geometry);

-- One MVT layer from polity_geometries rows of a source and admin-level range valid at a time.
-- use_simple: draw the precomputed simplified copy (large OHM states make low-zoom tiles slow).
CREATE OR REPLACE FUNCTION polity_tile_layer(
  layer text, src text, min_level integer, max_level integer,
  at_time double precision, bounds geometry, use_simple boolean)
RETURNS bytea LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(ST_AsMVT(t, layer, 4096, 'geom'), ''::bytea)
  FROM (
    SELECT p.id, p.name, polity_color(p.name) AS color, p.admin_level AS level, g.border_precision,
           ST_AsMVTGeom(ST_Transform(CASE WHEN use_simple THEN COALESCE(g.geom_simple, g.geom) ELSE g.geom END, 3857),
                        bounds, 4096, 64, true) AS geom
    FROM polity_geometries g
    JOIN polities p ON p.id = g.polity_id
    WHERE g.source = src
      AND p.admin_level BETWEEN min_level AND max_level
      AND g.valid_from <= at_time AND (g.valid_to IS NULL OR g.valid_to > at_time)
      AND g.geom && ST_Transform(bounds, 4326)
  ) t
  WHERE t.geom IS NOT NULL
$$;

-- Martin function source. `fallback` (HB) is drawn under `polities` (OHM level 2); `regions` are OHM levels 3-4.
CREATE OR REPLACE FUNCTION polities_tile(z integer, x integer, y integer, query_params json DEFAULT '{}')
RETURNS bytea LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  year_text text := query_params->>'year';
  at_time double precision;
  bounds geometry := ST_TileEnvelope(z, x, y);
BEGIN
  IF year_text IS NULL OR year_text !~ '^-?[0-9]{1,6}$' THEN
    RETURN ''::bytea;
  END IF;
  at_time := year_text::integer + 0.5;
  RETURN polity_tile_layer('fallback', 'hb', 2, 2, at_time, bounds, z <= 5)
      || polity_tile_layer('polities', 'ohm', 2, 2, at_time, bounds, z <= 5)
      || polity_tile_layer('regions', 'ohm', 3, 4, at_time, bounds, z <= 5);
END
$$;
