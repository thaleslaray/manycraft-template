-- Mensagem agendada pela equipe numa conversa: sai no horário pelo mesmo caminho da resposta humana (respeita janela e opt-in naquela hora).
-- Só quem agendou (ou dono/administrador) cancela.
CREATE TABLE inbox_scheduled_messages (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4096),
  send_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sending','sent','failed','cancelled')),
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX inbox_scheduled_due ON inbox_scheduled_messages (status, send_at);
CREATE INDEX inbox_scheduled_conversation ON inbox_scheduled_messages (workspace_id, conversation_id, send_at);
