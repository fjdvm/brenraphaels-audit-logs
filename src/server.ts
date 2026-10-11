import { Pool } from 'pg';
import { createApp } from './http/app.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const port = Number(process.env.PORT ?? 3000);
createApp(pool).listen(port, () => { console.log(`audit-logs listening on :${port}`); });
