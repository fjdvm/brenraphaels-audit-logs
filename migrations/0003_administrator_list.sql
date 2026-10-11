CREATE INDEX audit_events_newest ON audit_events (occurred_at DESC, recorded_at DESC, id DESC);
