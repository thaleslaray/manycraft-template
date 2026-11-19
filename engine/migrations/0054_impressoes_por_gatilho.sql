-- Impressões por gatilho: cada vez que o canal informa que o gatilho foi exibido/oferecido (hoje: link de referência aberto).
-- event_key evita contar duas vezes o mesmo evento reenviado pela fila.
CREATE TABLE trigger_impressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  occurred_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (trigger_id, event_key)
);
CREATE INDEX trigger_impressions_period ON trigger_impressions(workspace_id, trigger_id, occurred_at);
