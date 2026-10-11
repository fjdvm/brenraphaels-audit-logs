import { Pool } from 'pg';
import { anonymizeCustomer } from '../src/jobs/anonymize-customer/anonymize-customer.ts';
if (!process.env.DATABASE_URL_ANONYMIZE) throw new Error('DATABASE_URL_ANONYMIZE is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL_ANONYMIZE });
try {
  const [customerId] = process.argv.slice(2);
  if (!customerId) throw new Error('Usage: npm run anonymize-customer -- <customer id>');
  console.log(`Anonymized ${await anonymizeCustomer(pool, { type: 'customer', id: customerId })} Audit Events`);
} finally { await pool.end(); }
