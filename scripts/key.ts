import { Pool } from 'pg';
import { createKey, revokeKey } from '../src/api-keys/keys.ts';
if (!process.env.DATABASE_URL_MIGRATIONS) throw new Error('DATABASE_URL_MIGRATIONS is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATIONS });
try {
  const [command, value] = process.argv.slice(2);
  if (command === 'create' && value) console.log(await createKey(pool, value));
  else if (command === 'revoke' && value) await revokeKey(pool, value);
  else throw new Error('Usage: npm run key -- create <scope> | revoke <sha256 hash>');
} finally { await pool.end(); }
