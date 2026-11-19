-- Encurtador de links do corpo do texto (ligado por conexão): cada link vira um endereço curto com clique contado no passo.
CREATE TABLE short_links (
  token TEXT PRIMARY KEY CHECK (length(token)=10),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  url TEXT NOT NULL,
  clicked_at INTEGER,
  created_at INTEGER NOT NULL
);
