import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL_MIGRATIONS) throw new Error('DATABASE_URL_MIGRATIONS is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATIONS });
try {
  const migrations = ['0001_skeleton.sql', '0002_administrator_list.sql'];
  const requested = process.argv.slice(2);
  if (requested.some(name => !migrations.includes(name))) throw new Error('Unknown migration');
  for (const migration of requested.length ? requested : migrations) {
    await pool.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
} finally { await pool.end(); }
