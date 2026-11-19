-- Cada conexão possui uma entrada privada de cada tipo, com histórico no próprio gatilho.
CREATE UNIQUE INDEX IF NOT EXISTS triggers_basic_connection_kind
ON triggers(workspace_id, channel_id, kind)
WHERE kind IN ('default_reply', 'welcome_message') AND channel_id IS NOT NULL AND audience = 'direct';
