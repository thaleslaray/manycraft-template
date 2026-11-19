-- Chave de API do perfil: vale em todos os espaços em que a pessoa é dona, administradora ou editora (escolha por x-workspace). Só o hash fica guardado.
CREATE TABLE user_api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  last4 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX user_api_keys_user ON user_api_keys(user_id, revoked_at);
