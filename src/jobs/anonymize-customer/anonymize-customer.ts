import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { events } from '../../db/schema.ts';

export const ERASED_NAME = 'Deleted customer';

// Runs under audit_anonymize, which can UPDATE only the display-name, ip_address and user_agent columns (ADR-0002).
// IP address and user agent belong to whoever performed the Action, so they are cleared only where the Customer was the Actor.
export async function anonymizeCustomer(pool: Pool, customer: { type: string; id: string }): Promise<number> {
  const is = (type: AnyColumn, id: AnyColumn) => and(eq(type, customer.type), eq(id, customer.id))!;
  const asActor = is(events.actor_type, events.actor_id);
  const asSubject = is(events.subject_type, events.subject_id);
  const asTarget = is(events.target_type, events.target_id);
  const whereHeld = (held: SQL, column: AnyColumn, erased: unknown) => sql`CASE WHEN ${held} THEN ${erased} ELSE ${column} END`;
  const updated = await drizzle(pool).update(events).set({
    actor_display_name: whereHeld(asActor, events.actor_display_name, ERASED_NAME),
    subject_display_name: whereHeld(asSubject, events.subject_display_name, ERASED_NAME),
    target_display_name: whereHeld(asTarget, events.target_display_name, ERASED_NAME),
    ip_address: whereHeld(asActor, events.ip_address, null),
    user_agent: whereHeld(asActor, events.user_agent, null),
  }).where(or(asActor, asSubject, asTarget)).returning({ id: events.id });
  return updated.length;
}
