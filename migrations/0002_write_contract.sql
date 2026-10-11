ALTER TABLE audit_events ADD COLUMN metadata jsonb;
ALTER TABLE audit_events ADD COLUMN module text;
ALTER TABLE audit_events ADD COLUMN request_id text;
ALTER TABLE audit_events ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX audit_events_source_idempotency_key ON audit_events (source, idempotency_key);
