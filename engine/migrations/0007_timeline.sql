-- W4: system items share the messages cursor/tenant boundary, without affecting
-- unread counters or the last chat preview. source stays compatible with legacy SQL.
ALTER TABLE messages ADD COLUMN timeline_notified INTEGER NOT NULL DEFAULT 0;
CREATE INDEX inbox_pending_events ON messages(workspace_id,timeline_notified)
  WHERE json_extract(content,'$.sender')='system';
DROP TRIGGER inbox_message_insert;


CREATE TRIGGER timeline_run AFTER INSERT ON flow_runs
WHEN NEW.channel_id IS NOT NULL BEGIN
  INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at)
  SELECT 'event-run-' || NEW.id || '-' || timeline.id,NEW.workspace_id,timeline.id,'out','human',
    json_object('sender','system','text','','status','sent','event',json_object('kind','trigger','automation_id',(SELECT automation_id FROM automation_versions WHERE workspace_id=NEW.workspace_id AND id=NEW.automation_version_id),'automation_name',(SELECT a.name FROM automation_versions av JOIN automations a ON a.workspace_id=av.workspace_id AND a.id=av.automation_id WHERE av.workspace_id=NEW.workspace_id AND av.id=NEW.automation_version_id),'trigger_kind',coalesce((SELECT kind FROM triggers WHERE workspace_id=NEW.workspace_id AND id=NEW.trigger_id),'another_flow'))),NEW.created_at
  FROM (SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id WHERE v.workspace_id=NEW.workspace_id AND cc.contact_id=NEW.contact_id AND cc.channel_id=NEW.channel_id) timeline ;
END;

CREATE TRIGGER timeline_delay AFTER UPDATE ON flow_runs
WHEN NEW.status='waiting_delay' AND NEW.wait_until IS NOT NULL AND (OLD.status IS NOT NEW.status OR OLD.current_node_id IS NOT NEW.current_node_id) AND EXISTS (SELECT 1 FROM automation_versions av,json_each(av.graph,'$.nodes') n WHERE av.workspace_id=NEW.workspace_id AND av.id=NEW.automation_version_id AND json_extract(n.value,'$.id')=NEW.current_node_id AND json_extract(n.value,'$.type')='smart_delay') BEGIN
  INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at)
  SELECT 'event-' || lower(hex(randomblob(16))),NEW.workspace_id,timeline.id,'out','human',
    json_object('sender','system','text','','status','sent','event',json_object('kind','delay_started','automation_id',(SELECT automation_id FROM automation_versions WHERE workspace_id=NEW.workspace_id AND id=NEW.automation_version_id),'automation_name',(SELECT a.name FROM automation_versions av JOIN automations a ON a.workspace_id=av.workspace_id AND a.id=av.automation_id WHERE av.workspace_id=NEW.workspace_id AND av.id=NEW.automation_version_id),'ends_at',strftime('%Y-%m-%dT%H:%M:%fZ',NEW.wait_until/1000.0,'unixepoch'))),CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM (SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id WHERE v.workspace_id=NEW.workspace_id AND cc.contact_id=NEW.contact_id AND cc.channel_id=NEW.channel_id) timeline ;
END;

CREATE TRIGGER timeline_tag_added AFTER INSERT ON contact_tags
WHEN 1 BEGIN
  INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at)
  SELECT 'event-' || lower(hex(randomblob(16))),NEW.workspace_id,timeline.id,'out','human',
    json_object('sender','system','text','','status','sent','event',json_object('kind','tag_added','tag_id',NEW.tag_id,'tag_name',(SELECT name FROM tags WHERE workspace_id=NEW.workspace_id AND id=NEW.tag_id))),CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM (SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id WHERE v.workspace_id=NEW.workspace_id AND cc.contact_id=NEW.contact_id) timeline ;
END;

CREATE TRIGGER timeline_tag_removed AFTER DELETE ON contact_tags
WHEN 1 BEGIN
  INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at)
  SELECT 'event-' || lower(hex(randomblob(16))),OLD.workspace_id,timeline.id,'out','human',
    json_object('sender','system','text','','status','sent','event',json_object('kind','tag_removed','tag_id',OLD.tag_id,'tag_name',(SELECT name FROM tags WHERE workspace_id=OLD.workspace_id AND id=OLD.tag_id))),CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM (SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id WHERE v.workspace_id=OLD.workspace_id AND cc.contact_id=OLD.contact_id) timeline ;
END;

CREATE TRIGGER timeline_field_insert AFTER INSERT ON contact_field_values
WHEN 1 BEGIN
  INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at)
  SELECT 'event-' || lower(hex(randomblob(16))),NEW.workspace_id,timeline.id,'out','human',
    json_object('sender','system','text','','status','sent','event',json_object('kind','field_changed','field_id',NEW.field_id,'field_name',(SELECT name FROM custom_fields WHERE workspace_id=NEW.workspace_id AND id=NEW.field_id),'previous_value',NULL,'value',json(NEW.value))),CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM (SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id WHERE v.workspace_id=NEW.workspace_id AND cc.contact_id=NEW.contact_id) timeline ;
END;

CREATE TRIGGER timeline_field_update AFTER UPDATE ON contact_field_values
WHEN OLD.value IS NOT NEW.value BEGIN
  INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at)
  SELECT 'event-' || lower(hex(randomblob(16))),NEW.workspace_id,timeline.id,'out','human',
    json_object('sender','system','text','','status','sent','event',json_object('kind','field_changed','field_id',NEW.field_id,'field_name',(SELECT name FROM custom_fields WHERE workspace_id=NEW.workspace_id AND id=NEW.field_id),'previous_value',json(OLD.value),'value',json(NEW.value))),CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM (SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id WHERE v.workspace_id=NEW.workspace_id AND cc.contact_id=NEW.contact_id) timeline ;
END;

CREATE TRIGGER timeline_field_delete AFTER DELETE ON contact_field_values
WHEN 1 BEGIN
  INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at)
  SELECT 'event-' || lower(hex(randomblob(16))),OLD.workspace_id,timeline.id,'out','human',
    json_object('sender','system','text','','status','sent','event',json_object('kind','field_changed','field_id',OLD.field_id,'field_name',(SELECT name FROM custom_fields WHERE workspace_id=OLD.workspace_id AND id=OLD.field_id),'previous_value',json(OLD.value),'value',NULL)),CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM (SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id WHERE v.workspace_id=OLD.workspace_id AND cc.contact_id=OLD.contact_id) timeline ;
END;

CREATE TRIGGER timeline_status AFTER UPDATE ON conversations
WHEN OLD.status IS NOT NEW.status BEGIN
  INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at)
  SELECT 'event-' || lower(hex(randomblob(16))),NEW.workspace_id,timeline.id,'out','human',
    json_object('sender','system','text','','status','sent','event',json_object('kind','status_changed','previous_status',OLD.status,'status',NEW.status)),CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM (SELECT NEW.id AS id) timeline ;
END;

CREATE TRIGGER timeline_pause AFTER UPDATE ON contacts
WHEN OLD.automation_paused_until IS NOT NEW.automation_paused_until AND NEW.automation_paused_until > CAST(unixepoch('subsec')*1000 AS INTEGER) BEGIN
  INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at)
  SELECT 'event-' || lower(hex(randomblob(16))),NEW.workspace_id,timeline.id,'out','human',
    json_object('sender','system','text','','status','sent','event',json_object('kind','automation_paused','until',strftime('%Y-%m-%dT%H:%M:%fZ',NEW.automation_paused_until/1000.0,'unixepoch'))),CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM (SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id WHERE v.workspace_id=NEW.workspace_id AND cc.contact_id=NEW.id) timeline ;
END;

-- Existing run origins and currently held tags are recoverable; no invented history.
INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at,timeline_notified)
SELECT 'event-run-'||r.id||'-'||v.id,r.workspace_id,v.id,'out','human',
  json_object('sender','system','text','','status','sent','event',json_object('kind','trigger',
    'automation_id',a.id,'automation_name',a.name,'trigger_kind',coalesce(t.kind,'another_flow'))),r.created_at,1
FROM flow_runs r JOIN automation_versions av ON av.workspace_id=r.workspace_id AND av.id=r.automation_version_id
JOIN automations a ON a.workspace_id=av.workspace_id AND a.id=av.automation_id
JOIN contact_channels cc ON cc.workspace_id=r.workspace_id AND cc.contact_id=r.contact_id AND cc.channel_id=r.channel_id
JOIN conversations v ON v.workspace_id=cc.workspace_id AND v.contact_channel_id=cc.id
LEFT JOIN triggers t ON t.workspace_id=r.workspace_id AND t.id=r.trigger_id
ON CONFLICT(id) DO NOTHING;
INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at,timeline_notified)
SELECT 'event-tag-existing-'||ct.contact_id||'-'||ct.tag_id||'-'||v.id,ct.workspace_id,v.id,'out','human',
  json_object('sender','system','text','','status','sent','event',json_object('kind','tag_added',
    'tag_id',t.id,'tag_name',t.name)),ct.created_at,1
FROM contact_tags ct JOIN tags t ON t.workspace_id=ct.workspace_id AND t.id=ct.tag_id
JOIN contact_channels cc ON cc.workspace_id=ct.workspace_id AND cc.contact_id=ct.contact_id
JOIN conversations v ON v.workspace_id=cc.workspace_id AND v.contact_channel_id=cc.id
ON CONFLICT(id) DO NOTHING;

-- A node can toggle the same field/tag more than once. Guard the whole action
-- batch so a Workflow retry cannot replay those intermediate events.
CREATE TABLE timeline_action_receipts (
  run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  PRIMARY KEY(run_id,step_index)
);

-- Button labels are recovered from the immutable version, never from today's draft.
INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at,timeline_notified)
SELECT 'click-existing-'||ne.id,ne.workspace_id,v.id,'in','contact',
  json_object('sender','contact','text',json_extract(block.value,'$.label'),'status','delivered'),ne.created_at,1
FROM node_events ne JOIN flow_runs r ON r.workspace_id=ne.workspace_id AND r.id=ne.flow_run_id
JOIN automation_versions av ON av.workspace_id=r.workspace_id AND av.id=r.automation_version_id
JOIN json_each(av.graph,'$.nodes') node ON json_extract(node.value,'$.id')=ne.node_id
JOIN json_each(node.value,'$.config.blocks') block ON json_extract(block.value,'$.id')=ne.button_id AND json_extract(block.value,'$.kind')='button'
JOIN contact_channels cc ON cc.workspace_id=r.workspace_id AND cc.contact_id=r.contact_id AND cc.channel_id=r.channel_id
JOIN conversations v ON v.workspace_id=cc.workspace_id AND v.contact_channel_id=cc.id
WHERE ne.type='clicked' AND json_extract(block.value,'$.label') IS NOT NULL
ON CONFLICT(id) DO NOTHING;
INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at,timeline_notified)
SELECT 'event-delay-existing-'||r.id,r.workspace_id,v.id,'out','human',
  json_object('sender','system','text','','status','sent','event',json_object('kind','delay_started',
    'automation_id',a.id,'automation_name',a.name,'ends_at',strftime('%Y-%m-%dT%H:%M:%fZ',r.wait_until/1000.0,'unixepoch'))),r.updated_at,1
FROM flow_runs r JOIN automation_versions av ON av.workspace_id=r.workspace_id AND av.id=r.automation_version_id
JOIN automations a ON a.workspace_id=av.workspace_id AND a.id=av.automation_id
JOIN json_each(av.graph,'$.nodes') node ON json_extract(node.value,'$.id')=r.current_node_id AND json_extract(node.value,'$.type')='smart_delay'
JOIN contact_channels cc ON cc.workspace_id=r.workspace_id AND cc.contact_id=r.contact_id AND cc.channel_id=r.channel_id
JOIN conversations v ON v.workspace_id=cc.workspace_id AND v.contact_channel_id=cc.id
WHERE r.status='waiting_delay' AND r.wait_until IS NOT NULL
ON CONFLICT(id) DO NOTHING;
-- Historical inserts must not reopen conversations or increment unread counts.
CREATE TRIGGER inbox_message_insert AFTER INSERT ON messages
WHEN coalesce(json_extract(NEW.content,'$.sender'),'') <> 'system' BEGIN
  UPDATE conversations SET last_message_at=max(last_message_at,NEW.created_at),updated_at=NEW.created_at,
    unread_count=unread_count+CASE WHEN NEW.direction='in' THEN 1 ELSE 0 END,
    unread=CASE WHEN NEW.direction='in' THEN 1 ELSE unread END,
    status=CASE WHEN NEW.direction='in' THEN 'open' ELSE status END
  WHERE workspace_id=NEW.workspace_id AND id=NEW.conversation_id;
END;
