-- External message callback (bloco dinâmico): a próxima mensagem de texto do contato nesta conexão vai ao servidor do cliente em vez de disparar automações. Prazo máximo de 1 dia.
CREATE TABLE message_callbacks (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('post','put','patch','get','delete')),
  headers TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(headers)),
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, contact_id, channel_id)
);
