-- Pixel: o script no site do cliente guarda o mcp_token (28 dias) que chega pelos links rastreados e registra conversões e valores do contato.
ALTER TABLE workspaces ADD COLUMN pixel_enabled INTEGER NOT NULL DEFAULT 0 CHECK (pixel_enabled IN (0,1));
CREATE TABLE pixel_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('conversion','money')),
  name TEXT,
  amount REAL,
  currency TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX pixel_events_workspace ON pixel_events(workspace_id, created_at);
