import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL_MIGRATIONS) throw new Error('DATABASE_URL_MIGRATIONS is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATIONS });
try {
  await pool.query(await readFile(new URL('../migrations/0001_skeleton.sql', import.meta.url), 'utf8'));
} finally { await pool.end(); }
