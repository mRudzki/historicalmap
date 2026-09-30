import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildTimeline } from './timeline';

const pointSchema = {
  lat: { type: 'number', minimum: -90, maximum: 90 },
  lon: { type: 'number', minimum: -180, maximum: 180 },
} as const;

const atSchema = {
  querystring: {
    type: 'object',
    required: ['lat', 'lon', 'year'],
    properties: { ...pointSchema, year: { type: 'integer' } },
  },
} as const;

const timelineSchema = {
  querystring: { type: 'object', required: ['lat', 'lon'], properties: pointSchema },
} as const;

const POINT = 'ST_SetSRID(ST_MakePoint($1, $2), 4326)';

export function createApp(pool: pg.Pool): FastifyInstance {
  const app = Fastify();
  app.register(cors, { origin: true });

  const snapshotYears = async (): Promise<number[]> => {
    const { rows } = await pool.query(
      "SELECT DISTINCT valid_from::int AS year FROM polity_geometries WHERE source = 'hb' ORDER BY 1",
    );
    return rows.map((r) => r.year as number);
  };

  app.get('/snapshots', async () => ({ years: await snapshotYears() }));

  app.get('/at', { schema: atSchema }, async (req, reply) => {
    const { lat, lon, year } = req.query as { lat: number; lon: number; year: number };
    const years = await snapshotYears();
    if (years.length === 0 || year < years[0] || year > years[years.length - 1]) {
      return reply.code(400).send({ error: 'year out of range', min: years[0] ?? null, max: years.at(-1) ?? null });
    }
    const snap = await pool.query(
      "SELECT max(valid_from)::int AS year FROM polity_geometries WHERE source = 'hb' AND valid_from <= $1",
      [year],
    );
    const snapshotYear = snap.rows[0].year as number;
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (p.id) p.id, p.name,
              g.border_precision AS "borderPrecision", polity_color(p.name) AS color
       FROM polity_geometries g JOIN polities p ON p.id = g.polity_id
       WHERE g.source = 'hb' AND g.valid_from <= $3 AND (g.valid_to IS NULL OR g.valid_to > $3)
         AND ST_Intersects(g.geom, ${POINT})
       ORDER BY p.id, g.border_precision DESC NULLS LAST`,
      [lon, lat, year + 0.5],
    );
    return { year, snapshotYear, polities: rows };
  });

  app.get('/timeline', { schema: timelineSchema }, async (req) => {
    const { lat, lon } = req.query as { lat: number; lon: number };
    const { rows } = await pool.query(
      `SELECT DISTINCT p.name, polity_color(p.name) AS color, g.valid_from::int AS year
       FROM polity_geometries g
       JOIN polities p ON p.id = g.polity_id
       WHERE g.source = 'hb' AND ST_Intersects(g.geom, ${POINT})`,
      [lon, lat],
    );
    return { periods: buildTimeline(rows, await snapshotYears()) };
  });

  // One contour per polity that ever held the point: the union of that polity's geometries
  // from the snapshots containing it (simplified to keep the payload small).
  app.get('/history', { schema: timelineSchema }, async (req) => {
    const { lat, lon } = req.query as { lat: number; lon: number };
    const { rows } = await pool.query(
      `SELECT p.name, polity_color(p.name) AS color,
              array_agg(DISTINCT g.valid_from::int) AS years,
              ST_AsGeoJSON(ST_SimplifyPreserveTopology(ST_Union(g.geom), 0.02))::json AS geometry
       FROM polity_geometries g
       JOIN polities p ON p.id = g.polity_id
       WHERE g.source = 'hb' AND ST_Intersects(g.geom, ${POINT})
       GROUP BY p.id, p.name`,
      [lon, lat],
    );
    const allYears = await snapshotYears();
    const features = rows.map((r) => {
      const periods = buildTimeline(
        (r.years as number[]).map((year) => ({ name: r.name, color: r.color, year })),
        allYears,
      );
      return {
        type: 'Feature' as const,
        properties: {
          name: r.name as string,
          color: r.color as string,
          from: periods[0].from,
          to: periods[periods.length - 1].to,
          periods: periods.map(({ from, to }) => ({ from, to })),
        },
        geometry: r.geometry,
      };
    });
    features.sort((a, b) => a.properties.from - b.properties.from || a.properties.name.localeCompare(b.properties.name));
    return { type: 'FeatureCollection' as const, features };
  });

  return app;
}
