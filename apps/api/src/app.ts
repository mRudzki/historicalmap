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
    const { rows } = await pool.query('SELECT year FROM snapshots ORDER BY year');
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
      'SELECT s.id, s.year FROM snapshots s WHERE s.id = snapshot_for_year($1)',
      [year],
    );
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (p.id) p.id, p.name, p.subjecto,
              g.border_precision AS "borderPrecision", polity_color(p.name) AS color
       FROM polity_geometries g JOIN polities p ON p.id = g.polity_id
       WHERE g.snapshot_id = $3 AND ST_Intersects(g.geom, ${POINT})
       ORDER BY p.id, g.border_precision DESC NULLS LAST`,
      [lon, lat, snap.rows[0].id],
    );
    return { year, snapshotYear: snap.rows[0].year as number, polities: rows };
  });

  app.get('/timeline', { schema: timelineSchema }, async (req) => {
    const { lat, lon } = req.query as { lat: number; lon: number };
    const { rows } = await pool.query(
      `SELECT DISTINCT p.name, polity_color(p.name) AS color, s.year
       FROM polity_geometries g
       JOIN polities p ON p.id = g.polity_id
       JOIN snapshots s ON s.id = g.snapshot_id
       WHERE ST_Intersects(g.geom, ${POINT})`,
      [lon, lat],
    );
    return { periods: buildTimeline(rows, await snapshotYears()) };
  });

  return app;
}
