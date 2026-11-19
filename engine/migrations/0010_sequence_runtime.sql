-- Preserve enrollment identity across retries, and invalidate old executions on unsubscribe.
ALTER TABLE sequence_subscriptions ADD COLUMN channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE sequence_subscriptions ADD COLUMN enrollment_id TEXT;
ALTER TABLE sequence_subscriptions ADD COLUMN pending_run_id TEXT REFERENCES flow_runs(id) ON DELETE SET NULL;
ALTER TABLE sequence_subscriptions ADD COLUMN pending_step_id TEXT;
UPDATE sequence_subscriptions SET enrollment_id=lower(hex(randomblob(16)));
CREATE TABLE sequence_flow_runs (
  run_id TEXT PRIMARY KEY REFERENCES flow_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sequence_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  FOREIGN KEY(workspace_id,run_id) REFERENCES flow_runs(workspace_id,id)
);
CREATE INDEX sequence_flow_runs_enrollment ON sequence_flow_runs(workspace_id,sequence_id,contact_id,enrollment_id);
