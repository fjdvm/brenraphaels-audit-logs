-- Run once as the database owner. Set role login passwords separately.
CREATE ROLE audit_runtime LOGIN;
CREATE ROLE audit_anonymize LOGIN;
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
  actor_type text NOT NULL, actor_id text NOT NULL, actor_display_name text NOT NULL,
  target_type text NOT NULL, target_id text NOT NULL, target_display_name text NOT NULL,
  subject_type text, subject_id text, subject_display_name text,
  description text NOT NULL, customer_description text,
  occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  ip_address text, user_agent text
);
CREATE TABLE api_keys (
  hash text PRIMARY KEY, scope text NOT NULL, revoked_at timestamptz
);
GRANT USAGE ON SCHEMA public TO audit_runtime, audit_anonymize;
GRANT INSERT, SELECT ON audit_events TO audit_runtime;
GRANT SELECT ON api_keys TO audit_runtime;
GRANT SELECT ON audit_events TO audit_anonymize;
GRANT UPDATE (actor_display_name, target_display_name, subject_display_name, ip_address, user_agent)
  ON audit_events TO audit_anonymize;
