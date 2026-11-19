ALTER TABLE conversations ADD COLUMN unread_count INTEGER NOT NULL DEFAULT 0 CHECK(unread_count>=0);
CREATE INDEX inbox_recent ON conversations(workspace_id, last_message_at DESC, id DESC);
CREATE INDEX inbox_history ON messages(workspace_id, conversation_id, created_at DESC, id DESC);
-- Runs only on a new insertion: webhook/Workflow replay cannot double unread counts.
CREATE TRIGGER inbox_message_insert AFTER INSERT ON messages BEGIN
  UPDATE conversations SET last_message_at=max(last_message_at,NEW.created_at),updated_at=NEW.created_at,
    unread_count=unread_count+CASE WHEN NEW.direction='in' THEN 1 ELSE 0 END,
    unread=CASE WHEN NEW.direction='in' THEN 1 ELSE unread END,
    status=CASE WHEN NEW.direction='in' THEN 'open' ELSE status END
  WHERE workspace_id=NEW.workspace_id AND id=NEW.conversation_id;
END;
