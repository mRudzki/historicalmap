DROP FUNCTION IF EXISTS snapshot_for_year(integer);

-- The part of a polygon that lies on land. Modern OHM country polygons include territorial waters
-- (a buffer around every island), which makes coastlines look broken; clipping to the land mask
-- restores them. While the land table is empty the geometry is returned unchanged.
CREATE OR REPLACE FUNCTION clip_to_land(g geometry) RETURNS geometry
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM land) THEN g
    ELSE COALESCE(
      (SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Union(ST_Intersection(g, l.geom))), 3))
       FROM land l WHERE l.geom && g AND ST_Intersects(l.geom, g)),
      ST_GeomFromText('MULTIPOLYGON EMPTY', 4326))
  END
$$;

-- Valid, simplified MultiPolygon; the input itself if simplification leaves nothing.
CREATE OR REPLACE FUNCTION simplify_polygons(geom geometry, tolerance double precision) RETURNS geometry
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN ST_IsEmpty(s) THEN geom ELSE s END
  FROM (SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SimplifyPreserveTopology(geom, tolerance)), 3)) AS s) x
$$;

-- 0.02 degrees (~2 km): low-zoom tiles and the /history contours
CREATE OR REPLACE FUNCTION simplify_polygons(geom geometry) RETURNS geometry
LANGUAGE sql IMMUTABLE AS $$ SELECT simplify_polygons(geom, 0.02) $$;

-- 0.002 degrees (~200 m): point lookups and mid-zoom tiles
CREATE OR REPLACE FUNCTION simplify_lookup(geom geometry) RETURNS geometry
LANGUAGE sql IMMUTABLE AS $$ SELECT simplify_polygons(geom, 0.002) $$;

CREATE OR REPLACE FUNCTION polity_color(polity_name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN polity_name = 'Unnamed territory' THEN 'hsl(0, 0%, 80%)'
    ELSE 'hsl(' ||
      (('x' || substr(md5(polity_name), 1, 7))::bit(28)::int % 360) || ', 55%, 60%)'
  END
$$;

DROP FUNCTION IF EXISTS polity_tile_layer(text, text, integer, integer, double precision, geometry);
DROP FUNCTION IF EXISTS polity_tile_layer(text, text, integer, integer, double precision, geometry, boolean);

-- One MVT layer from polity_geometries rows of a source and admin-level range valid at a time.
-- detail: 'simple' (~2 km), 'lookup' (~200 m) or 'full' geometry; large OHM states make detailed low-zoom tiles slow.
CREATE OR REPLACE FUNCTION polity_tile_layer(
  layer text, src text, min_level integer, max_level integer,
  at_time double precision, bounds geometry, detail text)
RETURNS bytea LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(ST_AsMVT(t, layer, 4096, 'geom'), ''::bytea)
  FROM (
    SELECT p.id, p.name, polity_color(p.name) AS color, p.admin_level AS level, g.border_precision,
           ST_AsMVTGeom(ST_Transform(CASE detail WHEN 'simple' THEN COALESCE(g.geom_simple, g.geom)
                                          WHEN 'lookup' THEN COALESCE(g.geom_lookup, g.geom)
                                          ELSE g.geom END, 3857),
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
  detail text := CASE WHEN z <= 5 THEN 'simple' WHEN z <= 7 THEN 'lookup' ELSE 'full' END;
BEGIN
  IF year_text IS NULL OR year_text !~ '^-?[0-9]{1,6}$' THEN
    RETURN ''::bytea;
  END IF;
  at_time := year_text::integer + 0.5;
  RETURN polity_tile_layer('fallback', 'hb', 2, 2, at_time, bounds, detail)
      || polity_tile_layer('polities', 'ohm', 2, 2, at_time, bounds, detail)
      || polity_tile_layer('regions', 'ohm', 3, 4, at_time, bounds, detail);
END
$$;
