-- Anúncios que abrem conversa: token do login de anúncios (cifrado) para navegar conta > campanha > conjunto > anúncio.
CREATE TABLE ads_auth (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
