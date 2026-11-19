-- Local team notifications and conversion records never invoke a messaging provider.
CREATE TABLE team_notifications (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  recipient_id TEXT REFERENCES workspace_members(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, recipient_id) REFERENCES workspace_members(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX team_notifications_recipient ON team_notifications(workspace_id,recipient_id,created_at DESC);

CREATE TABLE conversion_events (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  value REAL CHECK (value IS NULL OR value >= 0),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, automation_id) REFERENCES automations(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX conversion_events_automation ON conversion_events(workspace_id,automation_id,created_at DESC);
