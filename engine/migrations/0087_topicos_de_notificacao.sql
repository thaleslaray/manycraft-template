-- Tópicos de notificação por conexão: o contato entra por um passo do fluxo e fica inscrito até a validade (re-opt-in renova).
CREATE TABLE notification_topics (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('daily','weekly','monthly')),
  validity_days INTEGER NOT NULL DEFAULT 180 CHECK (validity_days BETWEEN 1 AND 365),
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, channel_id, name)
);
CREATE TABLE topic_subscriptions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES notification_topics(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('subscribed','stopped')),
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (topic_id, contact_id)
);
CREATE INDEX topic_subscriptions_contact ON topic_subscriptions(workspace_id, contact_id);
