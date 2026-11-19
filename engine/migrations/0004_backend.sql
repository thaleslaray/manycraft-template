-- Account cleanup is a database trigger: cascade also works if deletion bypasses HTTP.
CREATE TRIGGER delete_user_workspace BEFORE DELETE ON "user" BEGIN
  DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM workspace_members WHERE user_id = OLD.id AND role = 'owner');
  UPDATE activity_logs SET actor_id = NULL WHERE actor_id = OLD.id OR actor_id IN (SELECT id FROM workspace_members WHERE user_id=OLD.id);
  DELETE FROM workspace_members WHERE user_id = OLD.id;
  DELETE FROM email_outbox WHERE recipient = OLD.email;
  DELETE FROM invites WHERE email = OLD.email;
  DELETE FROM verification WHERE identifier = OLD.email OR value = OLD.id
    OR (CASE WHEN json_valid(value) THEN json_extract(value, '$.email') = OLD.email ELSE 0 END);
END;
CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY, recipient TEXT NOT NULL, kind TEXT NOT NULL,
  subject TEXT NOT NULL, html TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE invites (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('administrator','editor','livechat_agent','viewer')),
  token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE request_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE TABLE media_objects (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- Server-only future webhook projection. No client mutation route and no paid processor configured.
CREATE TABLE subscriptions (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_customer_id TEXT UNIQUE, provider_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK(status IN ('inactive','trialing','active','past_due','canceled')),
  plan TEXT NOT NULL DEFAULT 'free' REFERENCES plan_limits(plan), last_event_id TEXT UNIQUE,
  updated_at INTEGER NOT NULL
);
