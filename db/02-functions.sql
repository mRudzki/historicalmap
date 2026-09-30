DROP FUNCTION IF EXISTS snapshot_for_year(integer);

CREATE OR REPLACE FUNCTION polity_color(polity_name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN polity_name = 'Unnamed territory' THEN 'hsl(0, 0%, 80%)'
    ELSE 'hsl(' ||
      (('x' || substr(md5(polity_name), 1, 7))::bit(28)::int % 360) || ', 55%, 60%)'
  END
$$;

-- Martin function source: tile (z,x,y) for the HB polities valid in ?year=
CREATE OR REPLACE FUNCTION polities_tile(z integer, x integer, y integer, query_params json DEFAULT '{}')
RETURNS bytea LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  year_text text := query_params->>'year';
  at_time double precision;
  bounds geometry := ST_TileEnvelope(z, x, y);
  result bytea;
BEGIN
  IF year_text IS NULL OR year_text !~ '^-?[0-9]{1,6}$' THEN
    RETURN ''::bytea;
  END IF;
  at_time := year_text::integer + 0.5;

  SELECT ST_AsMVT(t, 'polities', 4096, 'geom') INTO result
  FROM (
    SELECT p.id, p.name, polity_color(p.name) AS color, g.border_precision,
           ST_AsMVTGeom(ST_Transform(g.geom, 3857), bounds, 4096, 64, true) AS geom
    FROM polity_geometries g
    JOIN polities p ON p.id = g.polity_id
    WHERE g.source = 'hb'
      AND g.valid_from <= at_time AND (g.valid_to IS NULL OR g.valid_to > at_time)
      AND g.geom && ST_Transform(bounds, 4326)
  ) t
  WHERE t.geom IS NOT NULL;

  RETURN COALESCE(result, ''::bytea);
END
$$;
