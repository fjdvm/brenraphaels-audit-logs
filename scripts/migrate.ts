import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL_MIGRATIONS) throw new Error('DATABASE_URL_MIGRATIONS is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATIONS });
try {
  const migrations = ['0001_skeleton.sql', '0002_write_contract.sql', '0003_administrator_list.sql'];
  const requested = process.argv.slice(2);
  if (requested.some(name => !migrations.includes(name))) throw new Error('Unknown migration');
  const statements = await Promise.all((requested.length ? requested : migrations).map(name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')));
  await pool.query(`BEGIN;\n${statements.join('\n')}\nCOMMIT;`);
} finally { await pool.end(); }
