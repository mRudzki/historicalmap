import pg from 'pg';
import { createApp } from './app';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/historicalmap',
});
const app = createApp(pool);
const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });
console.log(`API listening on :${port}`);
