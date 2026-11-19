-- Link de compartilhamento de automação: quem recebe vê o mapa e salva uma cópia na própria conta.
CREATE TABLE automation_shares (
  token TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL,
  allow_copy INTEGER NOT NULL DEFAULT 1 CHECK (allow_copy IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  revoked_at INTEGER
);
CREATE INDEX automation_shares_automation ON automation_shares(workspace_id, automation_id);
