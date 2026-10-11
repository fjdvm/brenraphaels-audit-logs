import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
export const events = pgTable('audit_events', {
  module: text(),
  id: uuid().primaryKey(), source: text().notNull(), action: text().notNull(), outcome: text().notNull(),
  actor_type: text().notNull(), actor_id: text().notNull(), actor_display_name: text().notNull(),
  target_type: text().notNull(), target_id: text().notNull(), target_display_name: text().notNull(),
  subject_type: text(), subject_id: text(), subject_display_name: text(),
  description: text().notNull(), customer_description: text(),
  occurred_at: timestamp({ withTimezone: true }).notNull(),
  recorded_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  ip_address: text(), user_agent: text(),
});
export const keys = pgTable('api_keys', {
  hash: text().primaryKey(), scope: text().notNull(), revoked_at: timestamp({ withTimezone: true }),
});
