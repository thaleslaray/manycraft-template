-- Pedido de acesso: quem tem conta mas não é membro pede entrada; o dono ou um administrador aprova (vira membro com o papel escolhido) ou recusa.
CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 500),
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, user_id)
);
