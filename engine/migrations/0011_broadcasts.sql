-- W12: durable audience snapshot and recoverable batch queue; timestamps in milliseconds.
ALTER TABLE broadcasts ADD COLUMN content TEXT NOT NULL DEFAULT '';
ALTER TABLE broadcasts ADD COLUMN template TEXT CHECK(template IS NULL OR json_valid(template));
ALTER TABLE broadcasts ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo';
ALTER TABLE broadcasts ADD COLUMN scheduled_local TEXT NOT NULL DEFAULT '';
ALTER TABLE broadcasts ADD COLUMN started_at INTEGER;
ALTER TABLE broadcasts ADD COLUMN paused_at INTEGER;
ALTER TABLE broadcasts ADD COLUMN pause_reason TEXT;
ALTER TABLE broadcasts ADD COLUMN retry_at INTEGER;
ALTER TABLE broadcasts ADD COLUMN lease_token TEXT;
ALTER TABLE broadcasts ADD COLUMN lease_until INTEGER;
ALTER TABLE broadcasts ADD COLUMN enqueued_at INTEGER;
CREATE TABLE broadcast_recipients (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  broadcast_id TEXT NOT NULL,
  contact_channel_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','skipped','failed','uncertain')),
  reason TEXT,
  sent_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(broadcast_id,contact_channel_id),
  FOREIGN KEY(workspace_id,broadcast_id) REFERENCES broadcasts(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,contact_channel_id) REFERENCES contact_channels(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX broadcast_recipients_pending ON broadcast_recipients(broadcast_id,status,contact_channel_id);
CREATE INDEX broadcasts_queue_recovery ON broadcasts(status,enqueued_at) WHERE paused_at IS NULL;
