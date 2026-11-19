-- Connection layer: the Z-API provider (Omni Z-API, WhatsApp Web channel). The database still lists the providers it knows, so this
-- migration teaches it one more. The CHECK of channels.provider cannot be edited in place; as 0009 did for contacts.status, the column
-- is replaced (rename, add with the new CHECK, copy, drop) so rowids, foreign keys and indexes stay. Every trigger and the view that read
-- the column are dropped first (SQLite refuses to rename or drop a column they use) and recreated below with 'zapi' added.
DROP VIEW connections;
DROP TRIGGER channels_provider_kind;
DROP TRIGGER channels_provider_kind_update;
DROP TRIGGER channels_provider_default;
DROP TRIGGER channels_provider_follows_type;
DROP TRIGGER channels_provider_immutable;
DROP TRIGGER whatsapp_identity_insert;
DROP TRIGGER channels_updated;

ALTER TABLE channels RENAME COLUMN provider TO provider_before_zapi;
ALTER TABLE channels ADD COLUMN provider TEXT NOT NULL DEFAULT 'legacy'
  CHECK (provider IN ('legacy','meta_whatsapp_cloud','uazapi','zapi','telegram_bot','instagram_login','messenger_page'));
UPDATE channels SET provider = provider_before_zapi;
ALTER TABLE channels DROP COLUMN provider_before_zapi;

CREATE TRIGGER channels_updated AFTER UPDATE ON channels
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE channels SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

-- A provider only serves the channels it declares (mirrors ProviderAdapter.kinds; the registry test checks both).
CREATE TRIGGER channels_provider_kind BEFORE INSERT ON channels
WHEN NOT ((NEW.provider = 'legacy') OR (NEW.provider IN ('meta_whatsapp_cloud','uazapi','zapi') AND NEW.type = 'whatsapp')
  OR (NEW.provider = 'telegram_bot' AND NEW.type = 'telegram') OR (NEW.provider = 'instagram_login' AND NEW.type = 'instagram')
  OR (NEW.provider = 'messenger_page' AND NEW.type = 'messenger'))
BEGIN SELECT RAISE(ABORT, 'provider_kind_mismatch'); END;
CREATE TRIGGER channels_provider_kind_update BEFORE UPDATE OF provider ON channels
WHEN NOT ((NEW.provider = 'legacy') OR (NEW.provider IN ('meta_whatsapp_cloud','uazapi','zapi') AND NEW.type = 'whatsapp')
  OR (NEW.provider = 'telegram_bot' AND NEW.type = 'telegram') OR (NEW.provider = 'instagram_login' AND NEW.type = 'instagram')
  OR (NEW.provider = 'messenger_page' AND NEW.type = 'messenger'))
BEGIN SELECT RAISE(ABORT, 'provider_kind_mismatch'); END;
CREATE TRIGGER channels_provider_default AFTER INSERT ON channels WHEN NEW.provider = 'legacy'
BEGIN UPDATE channels SET provider = CASE NEW.type
  WHEN 'telegram' THEN 'telegram_bot' WHEN 'whatsapp' THEN 'meta_whatsapp_cloud'
  WHEN 'instagram' THEN 'instagram_login' WHEN 'messenger' THEN 'messenger_page' ELSE 'legacy' END
  WHERE id = NEW.id; END;
CREATE TRIGGER channels_provider_follows_type AFTER UPDATE OF type ON channels WHEN NEW.type IS NOT OLD.type
BEGIN UPDATE channels SET provider = CASE NEW.type
  WHEN 'telegram' THEN 'telegram_bot' WHEN 'whatsapp' THEN 'meta_whatsapp_cloud'
  WHEN 'instagram' THEN 'instagram_login' WHEN 'messenger' THEN 'messenger_page' ELSE 'legacy' END
  WHERE id = NEW.id; END;
CREATE TRIGGER channels_provider_immutable BEFORE UPDATE OF provider ON channels
WHEN NEW.provider IS NOT OLD.provider AND OLD.provider <> 'legacy' AND NEW.provider IS NOT CASE NEW.type
  WHEN 'telegram' THEN 'telegram_bot' WHEN 'whatsapp' THEN 'meta_whatsapp_cloud'
  WHEN 'instagram' THEN 'instagram_login' WHEN 'messenger' THEN 'messenger_page' ELSE 'legacy' END
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
