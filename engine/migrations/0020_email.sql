-- Registro do provedor preservando identidades, FKs e rowids.
DROP VIEW connections;
DROP TRIGGER channels_provider_kind;
DROP TRIGGER channels_provider_kind_update;
DROP TRIGGER channels_provider_default;
DROP TRIGGER channels_provider_follows_type;
DROP TRIGGER channels_provider_immutable;
DROP TRIGGER whatsapp_identity_insert;
DROP TRIGGER channels_updated;

ALTER TABLE channels RENAME COLUMN provider TO provider_before_email;
ALTER TABLE channels ADD COLUMN provider TEXT NOT NULL DEFAULT 'legacy'
  CHECK (provider IN ('legacy','meta_whatsapp_cloud','uazapi','zapi','cloudflare_email','telegram_bot','instagram_login','messenger_page'));
UPDATE channels SET provider = provider_before_email;
ALTER TABLE channels DROP COLUMN provider_before_email;

CREATE TRIGGER channels_updated AFTER UPDATE ON channels
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE channels SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

-- A provider only serves the channels it declares (mirrors ProviderAdapter.kinds; the registry test checks both).
CREATE TRIGGER channels_provider_kind BEFORE INSERT ON channels
WHEN NOT ((NEW.provider = 'legacy') OR (NEW.provider IN ('meta_whatsapp_cloud','uazapi','zapi') AND NEW.type = 'whatsapp')
  OR (NEW.provider = 'telegram_bot' AND NEW.type = 'telegram') OR (NEW.provider = 'instagram_login' AND NEW.type = 'instagram')
  OR (NEW.provider = 'messenger_page' AND NEW.type = 'messenger') OR (NEW.provider = 'cloudflare_email' AND NEW.type = 'email'))
BEGIN SELECT RAISE(ABORT, 'provider_kind_mismatch'); END;
CREATE TRIGGER channels_provider_kind_update BEFORE UPDATE OF provider ON channels
WHEN NOT ((NEW.provider = 'legacy') OR (NEW.provider IN ('meta_whatsapp_cloud','uazapi','zapi') AND NEW.type = 'whatsapp')
  OR (NEW.provider = 'telegram_bot' AND NEW.type = 'telegram') OR (NEW.provider = 'instagram_login' AND NEW.type = 'instagram')
  OR (NEW.provider = 'messenger_page' AND NEW.type = 'messenger') OR (NEW.provider = 'cloudflare_email' AND NEW.type = 'email'))
BEGIN SELECT RAISE(ABORT, 'provider_kind_mismatch'); END;
CREATE TRIGGER channels_provider_default AFTER INSERT ON channels WHEN NEW.provider = 'legacy'
BEGIN UPDATE channels SET provider = CASE NEW.type
  WHEN 'telegram' THEN 'telegram_bot' WHEN 'whatsapp' THEN 'meta_whatsapp_cloud'
  WHEN 'email' THEN 'cloudflare_email' WHEN 'instagram' THEN 'instagram_login' WHEN 'messenger' THEN 'messenger_page' ELSE 'legacy' END
  WHERE id = NEW.id; END;
CREATE TRIGGER channels_provider_follows_type AFTER UPDATE OF type ON channels WHEN NEW.type IS NOT OLD.type
BEGIN UPDATE channels SET provider = CASE NEW.type
  WHEN 'telegram' THEN 'telegram_bot' WHEN 'whatsapp' THEN 'meta_whatsapp_cloud'
  WHEN 'email' THEN 'cloudflare_email' WHEN 'instagram' THEN 'instagram_login' WHEN 'messenger' THEN 'messenger_page' ELSE 'legacy' END
  WHERE id = NEW.id; END;
CREATE TRIGGER channels_provider_immutable BEFORE UPDATE OF provider ON channels
WHEN NEW.provider IS NOT OLD.provider AND OLD.provider <> 'legacy' AND NEW.provider IS NOT CASE NEW.type
  WHEN 'telegram' THEN 'telegram_bot' WHEN 'whatsapp' THEN 'meta_whatsapp_cloud'
  WHEN 'email' THEN 'cloudflare_email' WHEN 'instagram' THEN 'instagram_login' WHEN 'messenger' THEN 'messenger_page' ELSE 'legacy' END
BEGIN SELECT RAISE(ABORT, 'connection_provider_immutable'); END;

-- Identity of a WhatsApp contact. The official provider needs a BSUID; UAZAPI brings a JID (phone or LID); Z-API brings the phone in digits
-- (Omni's `sender.identifier`, the same form `recipient.identifier` takes on send).
CREATE TRIGGER whatsapp_identity_insert BEFORE INSERT ON contact_channels
WHEN (EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id AND type = 'whatsapp' AND provider NOT IN ('uazapi','zapi'))
  AND (NEW.identity_kind != 'bsuid' OR NOT ((substr(NEW.external_user_id, 1, 3) GLOB '[A-Z][A-Z].'
  AND length(substr(NEW.external_user_id, 4)) BETWEEN 1 AND 128
  AND substr(NEW.external_user_id, 4) NOT GLOB '*[^A-Za-z0-9]*')
  OR (substr(NEW.external_user_id, 1, 7) GLOB '[A-Z][A-Z].ENT.'
  AND length(substr(NEW.external_user_id, 8)) BETWEEN 1 AND 128
  AND substr(NEW.external_user_id, 8) NOT GLOB '*[^A-Za-z0-9]*'))))
  OR (EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id AND type = 'whatsapp' AND provider = 'uazapi')
  AND (NEW.identity_kind != 'provider_id' OR coalesce(NEW.address_kind, '') NOT IN ('wa_pn','wa_lid')
    OR NOT (NEW.external_user_id GLOB '[0-9]*@s.whatsapp.net' OR NEW.external_user_id GLOB '[0-9]*@lid')))
  OR (EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id AND type = 'whatsapp' AND provider = 'zapi')
  AND (NEW.identity_kind != 'provider_id' OR coalesce(NEW.address_kind, '') != 'wa_pn'
    OR length(NEW.external_user_id) NOT BETWEEN 7 AND 15 OR NEW.external_user_id GLOB '*[^0-9]*'))
  OR (NEW.identity_kind != 'provider_id' AND NOT EXISTS
    (SELECT 1 FROM channels WHERE id = NEW.channel_id AND type = 'whatsapp'))
BEGIN SELECT RAISE(ABORT, 'whatsapp_requires_bsuid'); END;

CREATE VIEW connections AS
  SELECT id, workspace_id, type AS kind, provider, external_id, display_name, connection_state AS status,
         status_detail, settings, capabilities_override, webhook_mode, webhook_registered_at, archived_at,
         credentials_rotated_at AS rotated_at, created_at, updated_at
  FROM channels;



-- E-mail: configurações, remetentes, outbox correlacionável e métricas independentes de janela.
CREATE TABLE email_settings (
 workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 default_sender_id TEXT, company_name TEXT NOT NULL DEFAULT '',company_address TEXT NOT NULL DEFAULT '',
 balance REAL NOT NULL DEFAULT 0 CHECK(balance>=0), paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN(0,1)),
 bounce_threshold REAL NOT NULL DEFAULT .05,unsubscribe_threshold REAL NOT NULL DEFAULT .02,complaint_threshold REAL NOT NULL DEFAULT .001
);
CREATE TABLE email_senders (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 address TEXT NOT NULL,name TEXT NOT NULL,reply_to TEXT NOT NULL,branding INTEGER NOT NULL DEFAULT 1,
 is_platform INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'unverified' CHECK(status IN('unverified','dns_pending','verified','failed')),
 verification_token TEXT NOT NULL,verification_expires_at INTEGER,dns TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(dns)),warmup_accepted INTEGER NOT NULL DEFAULT 0,
 UNIQUE(workspace_id,address),UNIQUE(workspace_id,id)
);
CREATE TABLE email_drafts (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 content TEXT NOT NULL CHECK(json_valid(content)),updated_at INTEGER NOT NULL
);
CREATE TABLE email_messages (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
 sender_id TEXT NOT NULL REFERENCES email_senders(id) ON DELETE CASCADE,recipient TEXT NOT NULL,
 message_id TEXT NOT NULL UNIQUE,provider_message_id TEXT,reply_to TEXT NOT NULL,token TEXT NOT NULL UNIQUE,
 metadata TEXT CHECK(metadata IS NULL OR json_valid(metadata)),
 subject TEXT NOT NULL,preheader TEXT NOT NULL DEFAULT '',text TEXT NOT NULL,html TEXT NOT NULL,
 intent TEXT NOT NULL CHECK(intent IN('automation','human','broadcast','test')),status TEXT NOT NULL DEFAULT 'prepared',
 created_at INTEGER NOT NULL,FOREIGN KEY(workspace_id,connection_id) REFERENCES channels(workspace_id,id),
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id),FOREIGN KEY(workspace_id,sender_id) REFERENCES email_senders(workspace_id,id)
);
CREATE INDEX email_messages_usage ON email_messages(workspace_id,created_at,status);
CREATE TABLE email_events (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
 type TEXT NOT NULL CHECK(type IN('sent','delivered','opened','clicked','hard_bounce','soft_bounce','unsubscribed','complaint')),
 url TEXT,created_at INTEGER NOT NULL,
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id)
);
CREATE INDEX email_events_contact ON email_events(workspace_id,contact_id,type,created_at);
CREATE TABLE email_receipts (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,message_id TEXT NOT NULL,
 received_at INTEGER NOT NULL,queued_at INTEGER,PRIMARY KEY(workspace_id,message_id)
);
CREATE TABLE email_message_links (
 message_id TEXT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,link_id TEXT NOT NULL,url TEXT NOT NULL,
 PRIMARY KEY(message_id,link_id)
);
