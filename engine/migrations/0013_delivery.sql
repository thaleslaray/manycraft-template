-- Connection layer, F1 (Telegram): which connection a message used, and its delivery state.
-- Both nullable: history written before the layer keeps working (its connection stays in the external id prefix).
ALTER TABLE messages ADD COLUMN connection_id TEXT;
ALTER TABLE messages ADD COLUMN delivery_status TEXT
  CHECK (delivery_status IS NULL OR delivery_status IN ('sent','delivered','read','failed'));
ALTER TABLE messages ADD COLUMN delivery_error TEXT;
CREATE INDEX messages_connection_external ON messages (connection_id, external_message_id) WHERE connection_id IS NOT NULL;

-- Who the event came from, written at ingestion so erasure does not need each provider's payload layout.
ALTER TABLE inbound_events ADD COLUMN external_user_id TEXT;
CREATE INDEX inbound_events_user ON inbound_events (workspace_id, channel_id, external_user_id) WHERE external_user_id IS NOT NULL;
