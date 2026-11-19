-- Pedidos do titular (LGPD): quem pediu o quê e quando. Sobrevive à exclusão do contato (guarda só o id e o nome do momento).
CREATE TABLE data_subject_requests (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  contact_label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('access','export','correction','deletion','unsubscribe','other')),
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  requested_at INTEGER NOT NULL,
  recorded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX data_subject_requests_contact ON data_subject_requests (workspace_id, contact_id, requested_at DESC);
