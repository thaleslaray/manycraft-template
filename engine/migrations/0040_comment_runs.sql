-- Frozen comment context: the public comment never grants consent or a DM window.
ALTER TABLE flow_runs ADD COLUMN comment_context TEXT CHECK (comment_context IS NULL OR json_valid(comment_context));
-- A durable claim per effect and comment prevents a repeated webhook (or another trigger) sending again.
CREATE TABLE comment_effects (
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('private','public','like')),
  run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','sending','sent','uncertain')),
  external_id TEXT,
  PRIMARY KEY (channel_id,comment_id,effect),
  FOREIGN KEY (workspace_id,channel_id) REFERENCES channels(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,run_id) REFERENCES flow_runs(workspace_id,id) ON DELETE CASCADE
);
