-- Avisos da equipe fora do painel: contatos de aviso e preferências por membro, código de vínculo do chat
-- e fila de avisos (também serve de trava contra excesso: um por conversa a cada intervalo).
CREATE TABLE member_alert_settings (
  member_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email_enabled INTEGER NOT NULL DEFAULT 1 CHECK (email_enabled IN (0,1)),
  alert_email TEXT,
  chat_id TEXT,
  chat_channel_id TEXT,
  on_assigned_message INTEGER NOT NULL DEFAULT 0 CHECK (on_assigned_message IN (0,1)),
  on_unassigned INTEGER NOT NULL DEFAULT 0 CHECK (on_unassigned IN (0,1)),
  on_assigned_to_me INTEGER NOT NULL DEFAULT 0 CHECK (on_assigned_to_me IN (0,1))
);
CREATE TABLE alert_chat_codes (
  code TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_chat_id TEXT
);
CREATE TABLE member_alerts (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('inbox','flow')),
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  channels TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  result TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX member_alerts_throttle ON member_alerts(workspace_id,member_id,scope_id,origin,created_at);
CREATE INDEX member_alerts_pending ON member_alerts(status,created_at);
ALTER TABLE team_notifications ADD COLUMN via TEXT NOT NULL DEFAULT '[]';
ALTER TABLE team_notifications ADD COLUMN alerted INTEGER NOT NULL DEFAULT 1 CHECK (alerted IN (0,1));
