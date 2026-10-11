import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL_MIGRATIONS) throw new Error('DATABASE_URL_MIGRATIONS is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATIONS });
try {
  const skeleton = await readFile(new URL('../migrations/0001_skeleton.sql', import.meta.url), 'utf8');
  const writeContract = await readFile(new URL('../migrations/0002_write_contract.sql', import.meta.url), 'utf8');
  await pool.query(`BEGIN;\n${skeleton}\n${writeContract}\nCOMMIT;`);
} finally { await pool.end(); }
