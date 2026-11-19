CREATE TABLE inbox_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  pause_minutes INTEGER NOT NULL DEFAULT 30 CHECK(pause_minutes BETWEEN 0 AND 1440),
  new_message_behavior TEXT NOT NULL DEFAULT 'any_message' CHECK(new_message_behavior IN ('any_message','explicit'))
);
CREATE TABLE inbox_saved_replies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shortcut TEXT NOT NULL,
  body TEXT NOT NULL,
  UNIQUE(workspace_id,shortcut)
);
CREATE TABLE inbox_mentions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  read_at INTEGER,
  UNIQUE(message_id,member_id)
);
CREATE INDEX inbox_mentions_unread ON inbox_mentions(workspace_id,member_id,read_at);
DROP TRIGGER inbox_message_insert;
CREATE TRIGGER inbox_message_insert AFTER INSERT ON messages
WHEN coalesce(json_extract(NEW.content,'$.sender'),'') <> 'system' BEGIN
  UPDATE conversations SET last_message_at=max(last_message_at,NEW.created_at),updated_at=NEW.created_at,
    unread_count=unread_count+CASE WHEN NEW.direction='in' THEN 1 ELSE 0 END,
    unread=CASE WHEN NEW.direction='in' THEN 1 ELSE unread END,
    status=CASE WHEN NEW.direction='in' AND coalesce((SELECT new_message_behavior FROM inbox_settings WHERE workspace_id=NEW.workspace_id),'any_message')='any_message' THEN 'open' ELSE status END
  WHERE workspace_id=NEW.workspace_id AND id=NEW.conversation_id;
END;
CREATE TRIGGER inbox_initial_status AFTER INSERT ON conversations
WHEN (SELECT new_message_behavior FROM inbox_settings WHERE workspace_id=NEW.workspace_id)='explicit' BEGIN
  UPDATE conversations SET status='closed' WHERE id=NEW.id AND workspace_id=NEW.workspace_id;
END;
