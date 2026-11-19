-- Chave da API pública por espaço: guardamos só o hash; o final visível ajuda a reconhecer a chave na tela.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  hash TEXT NOT NULL UNIQUE,
  last4 TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX api_keys_workspace ON api_keys(workspace_id, revoked_at);
