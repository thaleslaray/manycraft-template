-- Integrações do espaço (ex.: Google Sheets por conta de serviço): a credencial fica cifrada como as das conexões.
CREATE TABLE workspace_integrations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('google_sheets')),
  label TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (workspace_id, kind)
);
