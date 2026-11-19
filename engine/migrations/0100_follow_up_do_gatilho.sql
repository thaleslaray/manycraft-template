-- Follow-up do gatilho: depois do disparo, se o contato não escrever em X minutos, outra automação começa para ele.
CREATE TABLE trigger_follow_ups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  done_at INTEGER,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('started','replied','unavailable'))
);
CREATE INDEX trigger_follow_ups_due ON trigger_follow_ups(done_at, due_at);
