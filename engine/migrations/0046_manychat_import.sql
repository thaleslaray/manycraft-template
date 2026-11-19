-- Origem dos fluxos importados da ManyChat: reimportar o mesmo namespace atualiza o rascunho em vez de duplicar.
CREATE TABLE manychat_flow_origins (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_ns TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  page_id TEXT,
  imported_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (workspace_id, source_ns),
  FOREIGN KEY (workspace_id, automation_id) REFERENCES automations(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX manychat_flow_origins_automation ON manychat_flow_origins(workspace_id, automation_id);
