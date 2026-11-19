-- Consumer keeps pending ingestion distinct from executed flows (processed_at remains NULL).
-- Retention never removes pending work. UTC timestamps are milliseconds since Unix epoch.
CREATE INDEX IF NOT EXISTS inbound_events_cleanup ON inbound_events(received_at) WHERE processed_at IS NOT NULL;
