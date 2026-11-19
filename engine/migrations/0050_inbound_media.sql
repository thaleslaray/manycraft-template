-- Mídia que o contato manda: baixada do canal por fila (com tentativas), guardada no armazenamento de mídia e ligada à mensagem da caixa de entrada.
-- Uma linha por evento recebido; `pending` guarda o número de tentativas, `failed` o motivo curto (nunca o texto do canal).
CREATE TABLE inbound_media (
  inbound_id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','audio','video','file','sticker')),
  status TEXT NOT NULL CHECK (status IN ('pending','stored','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  media_id TEXT REFERENCES media_objects(id) ON DELETE SET NULL,
  error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX inbound_media_workspace ON inbound_media(workspace_id, status);
