-- Connection layer, F6 (groups v1, D15): a trigger can listen to a WhatsApp group, in "keyword" or "mention" mode.
-- A group message never opens a private conversation: it is stored in group_messages, and the author becomes a contact.
CREATE TABLE group_threads (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  external_group_id TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','left','muted')),
  last_message_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (channel_id, external_group_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX group_threads_workspace ON group_threads (workspace_id, last_message_at DESC);

CREATE TABLE group_messages (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL PRIMARY KEY,
  group_thread_id TEXT NOT NULL,
  author_contact_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  external_message_id TEXT,
  mentions_me INTEGER NOT NULL DEFAULT 0 CHECK (mentions_me IN (0,1)),
  content TEXT NOT NULL CHECK (json_valid(content)),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (group_thread_id, external_message_id),
  FOREIGN KEY (workspace_id, group_thread_id) REFERENCES group_threads(workspace_id, id) ON DELETE CASCADE,
  -- CASCADE, not SET NULL: a composite SET NULL would also null workspace_id. What a person wrote goes with them (erasure).
  FOREIGN KEY (workspace_id, author_contact_id) REFERENCES contacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX group_messages_thread ON group_messages (group_thread_id, created_at DESC);

ALTER TABLE triggers ADD COLUMN audience TEXT NOT NULL DEFAULT 'direct' CHECK (audience IN ('direct','group'));
ALTER TABLE triggers ADD COLUMN group_match TEXT CHECK (group_match IS NULL OR group_match IN ('keyword','mention'));
ALTER TABLE triggers ADD COLUMN group_thread_id TEXT;   -- null = every group of the connection
CREATE TRIGGER triggers_group_mode BEFORE INSERT ON triggers
WHEN (NEW.audience = 'group') <> (NEW.group_match IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'group_match_requires_group_audience'); END;
CREATE INDEX triggers_audience ON triggers (workspace_id, audience, status);

-- A run born in a group answers in the group.
ALTER TABLE flow_runs ADD COLUMN reply_group_thread_id TEXT;
