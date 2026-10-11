import type { Pool } from 'pg';

export const ERASED_NAME = 'Deleted customer';

// Runs under audit_anonymize, which can UPDATE only the display-name, ip_address and user_agent columns (ADR-0002).
// IP address and user agent belong to whoever performed the Action, so they are cleared only where the Customer was the Actor.
export async function anonymizeCustomer(pool: Pool, customer: { type: string; id: string }): Promise<number> {
  const result = await pool.query(
    `UPDATE audit_events SET
       actor_display_name = CASE WHEN actor_type = $1 AND actor_id = $2 THEN $3 ELSE actor_display_name END,
       subject_display_name = CASE WHEN subject_type = $1 AND subject_id = $2 THEN $3 ELSE subject_display_name END,
       target_display_name = CASE WHEN target_type = $1 AND target_id = $2 THEN $3 ELSE target_display_name END,
       ip_address = CASE WHEN actor_type = $1 AND actor_id = $2 THEN NULL ELSE ip_address END,
       user_agent = CASE WHEN actor_type = $1 AND actor_id = $2 THEN NULL ELSE user_agent END
     WHERE (actor_type = $1 AND actor_id = $2) OR (subject_type = $1 AND subject_id = $2) OR (target_type = $1 AND target_id = $2)`,
    [customer.type, customer.id, ERASED_NAME],
  );
  return result.rowCount ?? 0;
}
