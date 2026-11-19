-- Consentimento dado na coleta (pergunta de e-mail ou telefone com opt-in): canal, frase mostrada e quando.
CREATE TABLE contact_consents (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('email','sms','whatsapp')),
  value TEXT NOT NULL,
  phrase TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX contact_consents_contact ON contact_consents (workspace_id, contact_id, created_at DESC);
