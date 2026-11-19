CREATE TABLE ai_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  goals TEXT NOT NULL DEFAULT '[{"id":"guide","title":"Apresentar o guia da coleção","description":"Conduzir a conversa até o material de apresentação.","enabled":true},{"id":"email","title":"Receber o e-mail de quem deseja acompanhar os próximos encontros","description":"Pedir o e-mail com consentimento para receber novidades.","enabled":true},{"id":"follow","title":"Convidar para acompanhar o perfil","description":"Sugerir o perfil para quem quer conhecer o trabalho.","enabled":false},{"id":"visit","title":"Convidar para conhecer o ateliê","description":"Orientar sobre os horários para uma visita.","enabled":false}]'
);
CREATE TABLE ai_knowledge (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL, content TEXT NOT NULL
);
CREATE INDEX ai_knowledge_workspace ON ai_knowledge(workspace_id);
CREATE TABLE ai_connections (
  connection_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
CREATE TABLE ai_sessions (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL, expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','human'))
);
CREATE TABLE ai_replies (
  inbound_id TEXT PRIMARY KEY REFERENCES inbound_events(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL, text TEXT NOT NULL, plan TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','sending','sent','handoff','uncertain','cancelled'))
);
CREATE TABLE ai_reply_parts (
  inbound_id TEXT NOT NULL REFERENCES ai_replies(inbound_id) ON DELETE CASCADE,
  part INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','sending','sent','uncertain')),
  external_id TEXT,
  PRIMARY KEY(inbound_id,part)
);
-- One row per source prevents a whole-workspace snapshot from exceeding D1's 2 MB row limit.
CREATE TABLE ai_session_knowledge (
  conversation_id TEXT NOT NULL REFERENCES ai_sessions(conversation_id) ON DELETE CASCADE,
  revision TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
  PRIMARY KEY(conversation_id,revision,source_id)
);
