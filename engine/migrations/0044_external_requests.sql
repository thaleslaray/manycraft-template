-- Visible log of external request actions: every failure and every manual test (successful runs are not stored).
CREATE TABLE external_request_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_id TEXT,
  node_id TEXT,
  run_id TEXT,
  contact_id TEXT,
  source TEXT NOT NULL CHECK(source IN ('run','test')),
  method TEXT NOT NULL,
  target TEXT NOT NULL,
  status INTEGER,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok','error')),
  error_code TEXT,
  message TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT(CAST(unixepoch('subsec')*1000 AS INTEGER))
);
CREATE INDEX external_request_logs_recent ON external_request_logs(workspace_id,created_at DESC);
CREATE INDEX external_request_logs_automation ON external_request_logs(workspace_id,automation_id,created_at DESC);
