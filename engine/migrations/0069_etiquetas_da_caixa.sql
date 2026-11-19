-- Etiquetas da Caixa de entrada: marcam conversas (não contatos). Manuais pela equipe; automáticas quando o contato casa a condição ao chegar mensagem.
CREATE TABLE inbox_labels (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  color TEXT NOT NULL DEFAULT 'neutral' CHECK (color IN ('neutral','accent','success','warning','danger')),
  condition TEXT CHECK (condition IS NULL OR json_valid(condition)),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, name)
);
CREATE TABLE conversation_labels (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES inbox_labels(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (conversation_id, label_id)
);
CREATE INDEX conversation_labels_label ON conversation_labels (label_id);
