-- Modelos por conexão: rascunho, revisão, qualidade e cabeçalhos de mídia.
CREATE TABLE message_templates_next (
  id TEXT NOT NULL primary key,
  workspace_id TEXT not null references workspaces(id) on delete cascade,
  channel_id TEXT not null references channels(id) on delete cascade,
  group_id TEXT not null,
  language_code text not null,
  is_default INTEGER not null default 0 CHECK (is_default IN (0,1)),
  name_human text not null check (length(name_human) <= 512),
  category text not null default 'utility' check (category in ('utility','marketing','authentication')),
  status text not null default 'pending' check (status in ('draft','submitting','uncertain','pending','disabled','paused','approved','rejected','deleted')),
  header_type text not null default 'none' check (header_type in ('none','text','image','video','document')),
  header_text text check (header_text is null or length(header_text) <= 40),
  header_media_url text,
  body text not null check (length(body) <= 1024),
  buttons TEXT not null default '[]' CHECK (buttons IS NULL OR json_valid(buttons)),
  example TEXT not null default '{}' CHECK (example IS NULL OR json_valid(example)),
  footer TEXT NOT NULL DEFAULT '' CHECK (length(footer)<=60),
  quality TEXT NOT NULL DEFAULT 'unknown' CHECK (quality IN ('unknown','green','yellow','red')),
  provider_id TEXT,
  submitted_at INTEGER,
  synced_at INTEGER,
  header_example TEXT,
  rejection_reason TEXT,
  last_edited_at INTEGER,
  created_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER not null default (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  unique (group_id, language_code),
  check (header_type <> 'text' or header_text is not null),
  check (header_type <> 'image' or header_media_url is not null),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO message_templates_next (id,workspace_id,channel_id,group_id,language_code,is_default,name_human,category,status,header_type,header_text,header_media_url,body,buttons,example,last_edited_at,created_at,updated_at) SELECT id,workspace_id,channel_id,group_id,language_code,is_default,name_human,category,status,header_type,header_text,header_media_url,body,buttons,example,last_edited_at,created_at,updated_at FROM message_templates;
DROP TABLE message_templates;
ALTER TABLE message_templates_next RENAME TO message_templates;
CREATE UNIQUE INDEX message_templates_connection_name_language ON message_templates(workspace_id,channel_id,name_human,language_code);

CREATE INDEX message_templates_lookup_40 ON message_templates (workspace_id, status);
CREATE INDEX message_templates_lookup_41 ON message_templates (channel_id);
create unique index message_templates_one_default on message_templates (group_id) where is_default;
CREATE INDEX message_templates_workspace ON message_templates (workspace_id);
CREATE TRIGGER message_templates_updated AFTER UPDATE ON message_templates
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE message_templates SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;
