-- IA nos comentários: quando nenhum gatilho de comentário pega, a IA responde em público com a base de conhecimento (uma vez por comentário).
ALTER TABLE ai_settings ADD COLUMN comments_enabled INTEGER NOT NULL DEFAULT 0 CHECK (comments_enabled IN (0,1));
CREATE TABLE ai_comment_replies (
  comment_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  outcome TEXT,
  text TEXT,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','sent','skipped','failed')),
  created_at INTEGER NOT NULL
);
