-- Durable plan separates Queue retries from trigger selection/publication changes.
ALTER TABLE inbound_events ADD COLUMN planned_at INTEGER;
ALTER TABLE contact_channels ADD COLUMN first_inbound_id TEXT;
ALTER TABLE flow_runs ADD COLUMN inbound_event_id TEXT;
ALTER TABLE flow_runs ADD COLUMN channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE flow_runs ADD COLUMN start_node_id TEXT;
ALTER TABLE flow_runs ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flow_runs ADD COLUMN workflow_created_at INTEGER;
CREATE INDEX flow_runs_inbound ON flow_runs(workspace_id, inbound_event_id);
CREATE TABLE button_tokens (
  token TEXT PRIMARY KEY CHECK (length(token) <= 32),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  button_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(run_id, step_index, button_id),
  FOREIGN KEY(workspace_id, run_id) REFERENCES flow_runs(workspace_id, id)
);
CREATE INDEX button_tokens_expiry ON button_tokens(expires_at);
CREATE TABLE flow_clicks (
  run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  token TEXT NOT NULL,
  inbound_event_id TEXT NOT NULL,
  delivered_at INTEGER,
  PRIMARY KEY(run_id, step_index)
);
-- Bot API has no idempotency key: preserve ambiguous sends instead of blindly resending.
CREATE TABLE flow_outbound (
  run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  part INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','sending','sent','uncertain')),
  external_message_id INTEGER,
  PRIMARY KEY(run_id, step_index, part)
);
CREATE TABLE flow_random_assignments (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  variation_id TEXT NOT NULL,
  PRIMARY KEY(automation_id, contact_id, node_id),
  FOREIGN KEY(workspace_id, automation_id) REFERENCES automations(workspace_id, id),
  FOREIGN KEY(workspace_id, contact_id) REFERENCES contacts(workspace_id, id)
);
