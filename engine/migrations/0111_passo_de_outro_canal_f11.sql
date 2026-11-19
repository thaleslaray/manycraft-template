-- Ficha 11: passo de mensagem de outro canal é pulado pela execução; o motivo fica gravado (nunca um pulo calado).
CREATE TABLE flow_step_skips (
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('channel_mismatch')),
  step_channel TEXT NOT NULL,
  run_channel TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (run_id, step_index)
);
CREATE INDEX flow_step_skips_automation ON flow_step_skips(workspace_id, automation_id, node_id);
