import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { displayPeriod, resolveTimeline, type Interval } from './resolve-timeline';

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

const historySchema = {
  querystring: {
    type: 'object',
    required: ['lat', 'lon'],
    properties: { ...pointSchema, levels: { type: 'string', pattern: '^[2-4](,[2-4])*$' } },
  },
} as const;

const POINT = 'ST_SetSRID(ST_MakePoint($1, $2), 4326)';
const VALID_AT = 'g.valid_from <= $3 AND (g.valid_to IS NULL OR g.valid_to > $3)';
const BASE = 'FROM polity_geometries g JOIN polities p ON p.id = g.polity_id';

interface IntervalRow { name: string; color: string; source: 'ohm' | 'hb'; valid_from: number; valid_to: number | null }
const intervals = (rows: IntervalRow[], source: 'ohm' | 'hb'): Interval[] =>
  rows.filter((r) => r.source === source).map((r) => ({ name: r.name, color: r.color, from: r.valid_from, to: r.valid_to }));

export function createApp(pool: pg.Pool): FastifyInstance {
  const app = Fastify();
  app.register(cors, { origin: true });

  const range = async (): Promise<{ min: number | null; max: number | null }> => {
    const { rows } = await pool.query('SELECT floor(min(valid_from))::int AS min FROM polity_geometries');
    const min = rows[0].min as number | null;
    return min === null ? { min: null, max: null } : { min, max: new Date().getFullYear() };
  };

  app.get('/range', async () => range());

  app.get('/at', { schema: atSchema }, async (req, reply) => {
    const { lat, lon, year } = req.query as { lat: number; lon: number; year: number };
    const r = await range();
    if (r.min === null || year < r.min || year > (r.max as number)) {
      return reply.code(400).send({ error: 'year out of range', min: r.min, max: r.max });
    }
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (p.id, g.source) p.id, p.name, p.admin_level AS "adminLevel", g.source,
              g.border_precision AS "borderPrecision", polity_color(p.name) AS color
       ${BASE}
       WHERE ${VALID_AT} AND ST_Intersects(g.geom, ${POINT})
       ORDER BY p.id, g.source, g.border_precision DESC NULLS LAST`,
      [lon, lat, year + 0.5],
    );
    const states = (source: string) => rows.filter((x) => x.source === source && x.adminLevel === 2);
    const ohmStates = states('ohm');
    const polities = ohmStates.length > 0 ? ohmStates : states('hb'); // OHM wins, HB fills the gap
    const regions = rows
      .filter((x) => x.source === 'ohm' && x.adminLevel > 2)
      .sort((a, b) => a.adminLevel - b.adminLevel || a.name.localeCompare(b.name));
    return { year, polities, regions };
  });

  app.get('/timeline', { schema: timelineSchema }, async (req) => {
    const { lat, lon } = req.query as { lat: number; lon: number };
    const { rows } = await pool.query(
      `SELECT p.name, polity_color(p.name) AS color, g.source, g.valid_from, g.valid_to
       ${BASE}
       WHERE p.admin_level = 2 AND ST_Intersects(g.geom, ${POINT})`,
      [lon, lat],
    );
    return { periods: resolveTimeline(intervals(rows, 'ohm'), intervals(rows, 'hb')).map(displayPeriod) };
  });

  // One contour per polity that ever held the point: the union of its geometries containing the
  // point. Unions the precomputed simplified copies: unioning the raw geometries of a state
  // (some are huge) took ~40 s. HB polities count only if some interval survives OHM precedence.
  app.get('/history', { schema: historySchema }, async (req) => {
    const { lat, lon, levels } = req.query as { lat: number; lon: number; levels?: string };
    const wanted = (levels ?? '2').split(',').map(Number);
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.admin_level AS level, polity_color(p.name) AS color,
              g.source, g.valid_from, g.valid_to
       ${BASE}
       WHERE p.admin_level = ANY($3::int[]) AND ST_Intersects(g.geom, ${POINT})`,
      [lon, lat, wanted],
    );

    type Row = IntervalRow & { id: number; level: number };
    const all = rows as Row[];
    const entries: { id: number; level: number; periods: ReturnType<typeof resolveTimeline> }[] = [];

    const stateRows = all.filter((r) => r.level === 2);
    for (const period of resolveTimeline(intervals(stateRows, 'ohm'), intervals(stateRows, 'hb'))) {
      const id = stateRows.find((r) => r.name === period.name)!.id;
      const existing = entries.find((e) => e.id === id);
      if (existing) existing.periods.push(period);
      else entries.push({ id, level: 2, periods: [period] });
    }
    const regionIds = [...new Set(all.filter((r) => r.level > 2).map((r) => r.id))];
    for (const id of regionIds) {
      const own = all.filter((r) => r.id === id);
      entries.push({ id, level: own[0].level, periods: resolveTimeline(intervals(own, 'ohm'), []) });
    }
    if (entries.length === 0) return { type: 'FeatureCollection' as const, features: [] };

    const geo = await pool.query(
      `SELECT p.id, ST_AsGeoJSON(ST_SimplifyPreserveTopology(ST_CollectionExtract(
                ST_MakeValid(ST_Union(COALESCE(g.geom_simple, g.geom))), 3), 0.02))::json AS geometry
       ${BASE}
       WHERE p.id = ANY($3::int[]) AND ST_Intersects(g.geom, ${POINT})
       GROUP BY p.id`,
      [lon, lat, entries.map((e) => e.id)],
    );
    const geometry = new Map(geo.rows.map((r) => [r.id as number, r.geometry]));

    const features = entries.map((e) => {
      const display = e.periods.map(displayPeriod);
      const first = all.find((r) => r.id === e.id)!;
      return {
        type: 'Feature' as const,
        properties: {
          name: first.name,
          color: first.color,
          level: e.level,
          source: e.periods.some((p) => p.source === 'ohm') ? ('ohm' as const) : ('hb' as const),
          from: display[0].from,
          to: display[display.length - 1].to,
          periods: display.map(({ from, to }) => ({ from, to })),
        },
        geometry: geometry.get(e.id),
      };
    });
    features.sort((a, b) => a.properties.from - b.properties.from || a.properties.name.localeCompare(b.properties.name));
    return { type: 'FeatureCollection' as const, features };
  });

  return app;
}
