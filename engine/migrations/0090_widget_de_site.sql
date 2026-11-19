-- Widget de site: um script que mostra um botão flutuante levando ao link de entrada da conversa; o diagnóstico confere a instalação.
CREATE TABLE site_widgets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  target_url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
