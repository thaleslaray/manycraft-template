-- Global rules keep their mutable draft separate from the published configuration.
-- Keep the original schema and its dormant discriminators for compatibility. The new
-- runtime reads only these explicit draft/published snapshots; old rows stay inactive.
ALTER TABLE rules ADD COLUMN active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1));
ALTER TABLE rules ADD COLUMN draft TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(draft));
ALTER TABLE rules ADD COLUMN published TEXT CHECK(published IS NULL OR json_valid(published));
ALTER TABLE rules ADD COLUMN published_at INTEGER;
UPDATE rules SET draft=json_object('trigger',json_patch('{}',json_object('type',CASE event_type
  WHEN 'add_tag' THEN 'tag_added' WHEN 'remove_tag' THEN 'tag_removed' WHEN 'change_field_value' THEN 'field_changed'
  WHEN 'subscribe_sequence' THEN 'sequence_entered' WHEN 'datetime' THEN 'date' WHEN 'user_created' THEN 'contact_created' ELSE NULL END,
  'field_id',CASE WHEN event_type='datetime' THEN date_field_id ELSE NULL END)),
  'event_filter',json(CASE WHEN json_type(event_config)='object' THEN event_config ELSE '{}' END),'frequency',frequency,'actions',
  json(CASE WHEN action_type='start_flow' THEN json_array(json_object('type','start_automation','automation_id',automation_id)) ELSE '[]' END))
  WHERE draft='{}';
CREATE TABLE rule_events (
  id TEXT PRIMARY KEY DEFAULT(lower(hex(randomblob(16)))), workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type TEXT NOT NULL, resource_id TEXT, value TEXT, created_at INTEGER NOT NULL DEFAULT(CAST(unixepoch('subsec')*1000 AS INTEGER)),
  processed_at INTEGER, retry_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id)
);
CREATE INDEX rule_events_pending ON rule_events(processed_at,retry_at,workspace_id,created_at);
CREATE TABLE rule_executions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL, config TEXT NOT NULL CHECK(json_valid(config)),
  created_at INTEGER NOT NULL, actions_applied_at INTEGER, completed_at INTEGER, skipped_at INTEGER, skip_reason TEXT,
  UNIQUE(rule_id,event_id),
  FOREIGN KEY(workspace_id,rule_id) REFERENCES rules(workspace_id,id),
  FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id)
);
CREATE INDEX rule_executions_frequency ON rule_executions(rule_id,contact_id,created_at);
-- These markers exist only inside the same D1 transaction as a bulk write.
CREATE TABLE rule_event_suppressions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY(workspace_id,contact_id,type)
);
CREATE TRIGGER rule_contact_created AFTER INSERT ON contacts
WHEN NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.id AND type='contacts') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type) VALUES(NEW.workspace_id,NEW.id,'contact_created');
END;
CREATE TRIGGER rule_tag_added AFTER INSERT ON contact_tags
WHEN NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.contact_id AND type='tags') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type,resource_id) VALUES(NEW.workspace_id,NEW.contact_id,'tag_added',NEW.tag_id);
END;
CREATE TRIGGER rule_tag_removed AFTER DELETE ON contact_tags
WHEN EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) AND EXISTS(SELECT 1 FROM contacts WHERE id=OLD.contact_id)
AND EXISTS(SELECT 1 FROM tags WHERE workspace_id=OLD.workspace_id AND id=OLD.tag_id) AND NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=OLD.workspace_id AND contact_id=OLD.contact_id AND type='tags') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type,resource_id) VALUES(OLD.workspace_id,OLD.contact_id,'tag_removed',OLD.tag_id);
END;
CREATE TRIGGER rule_field_inserted AFTER INSERT ON contact_field_values
WHEN NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.contact_id AND type='fields') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type,resource_id,value) VALUES(NEW.workspace_id,NEW.contact_id,'field_changed',NEW.field_id,NEW.value);
END;
CREATE TRIGGER rule_field_updated AFTER UPDATE OF value ON contact_field_values WHEN OLD.value IS NOT NEW.value
AND NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.contact_id AND type='fields') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type,resource_id,value) VALUES(NEW.workspace_id,NEW.contact_id,'field_changed',NEW.field_id,NEW.value);
END;
CREATE TRIGGER rule_field_removed AFTER DELETE ON contact_field_values
WHEN EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) AND EXISTS(SELECT 1 FROM contacts WHERE id=OLD.contact_id)
AND EXISTS(SELECT 1 FROM custom_fields WHERE workspace_id=OLD.workspace_id AND id=OLD.field_id)
AND NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=OLD.workspace_id AND contact_id=OLD.contact_id AND type='fields') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type,resource_id,value) VALUES(OLD.workspace_id,OLD.contact_id,'field_changed',OLD.field_id,'null');
END;
CREATE TRIGGER rule_sequence_entered AFTER INSERT ON sequence_subscriptions
WHEN NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.contact_id AND type='sequences') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type,resource_id) VALUES(NEW.workspace_id,NEW.contact_id,'sequence_entered',NEW.sequence_id);
END;
