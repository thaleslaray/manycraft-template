-- Webhook de integração gerado pela plataforma (ex.: Hotmart): o token da URL acha o espaço; o hottok, quando informado, confere a origem.
CREATE TABLE integration_hooks (
  token TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('hotmart')),
  secret TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  last_received_at INTEGER,
  UNIQUE (workspace_id, kind)
);
