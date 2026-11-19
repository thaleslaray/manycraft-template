-- Chaves próprias de provedores de LLM (ChatGPT, Claude, DeepSeek) ao lado do Google Sheets.
CREATE TABLE workspace_integrations_new (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('google_sheets','openai','anthropic','deepseek')),
  label TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (workspace_id, kind)
);
INSERT INTO workspace_integrations_new SELECT * FROM workspace_integrations;
DROP TABLE workspace_integrations;
ALTER TABLE workspace_integrations_new RENAME TO workspace_integrations;
