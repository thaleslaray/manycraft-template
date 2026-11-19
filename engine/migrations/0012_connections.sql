-- Connection layer, step 1 (F0): a channel row becomes a Connection. No behaviour change.
-- Credentials, webhook secret and archive columns arrive with F4 (see replica/arquitetura-mensageria.md §2.2).
ALTER TABLE channels ADD COLUMN provider TEXT NOT NULL DEFAULT 'legacy'
  CHECK (provider IN ('legacy','meta_whatsapp_cloud','uazapi','telegram_bot','instagram_login','messenger_page'));
ALTER TABLE channels ADD COLUMN settings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings));
ALTER TABLE channels ADD COLUMN capabilities_override TEXT CHECK (capabilities_override IS NULL OR json_valid(capabilities_override));
-- channels.status only allows connected/disconnected/error and its CHECK cannot change without recreating the table,
-- so the wider state set lives here.
ALTER TABLE channels ADD COLUMN connection_state TEXT NOT NULL DEFAULT 'connected'
  CHECK (connection_state IN ('pending','connecting','connected','disconnected','error','restricted'));

-- Backfill the existing connections
UPDATE channels SET provider = CASE type
  WHEN 'telegram' THEN 'telegram_bot' WHEN 'whatsapp' THEN 'meta_whatsapp_cloud'
  WHEN 'instagram' THEN 'instagram_login' WHEN 'messenger' THEN 'messenger_page' ELSE 'legacy' END;
UPDATE channels SET connection_state = status;

CREATE INDEX channels_workspace_kind ON channels (workspace_id, type, connection_state);

-- A provider only serves the channels it declares (mirrors ProviderAdapter.kinds; the registry test checks both).
CREATE TRIGGER channels_provider_kind BEFORE INSERT ON channels
WHEN NOT ((NEW.provider = 'legacy') OR (NEW.provider IN ('meta_whatsapp_cloud','uazapi') AND NEW.type = 'whatsapp')
  OR (NEW.provider = 'telegram_bot' AND NEW.type = 'telegram') OR (NEW.provider = 'instagram_login' AND NEW.type = 'instagram')
  OR (NEW.provider = 'messenger_page' AND NEW.type = 'messenger'))
BEGIN SELECT RAISE(ABORT, 'provider_kind_mismatch'); END;
CREATE TRIGGER channels_provider_kind_update BEFORE UPDATE OF provider ON channels
WHEN NOT ((NEW.provider = 'legacy') OR (NEW.provider IN ('meta_whatsapp_cloud','uazapi') AND NEW.type = 'whatsapp')
  OR (NEW.provider = 'telegram_bot' AND NEW.type = 'telegram') OR (NEW.provider = 'instagram_login' AND NEW.type = 'instagram')
  OR (NEW.provider = 'messenger_page' AND NEW.type = 'messenger'))
BEGIN SELECT RAISE(ABORT, 'provider_kind_mismatch'); END;
-- Rows created by pre-layer code omit provider; give them their channel's default.
CREATE TRIGGER channels_provider_default AFTER INSERT ON channels WHEN NEW.provider = 'legacy'
BEGIN UPDATE channels SET provider = CASE NEW.type
  WHEN 'telegram' THEN 'telegram_bot' WHEN 'whatsapp' THEN 'meta_whatsapp_cloud'
  WHEN 'instagram' THEN 'instagram_login' WHEN 'messenger' THEN 'messenger_page' ELSE 'legacy' END
  WHERE id = NEW.id; END;
-- A type change re-derives the provider (only test setup does this today).
CREATE TRIGGER channels_provider_follows_type AFTER UPDATE OF type ON channels WHEN NEW.type IS NOT OLD.type
BEGIN UPDATE channels SET provider = CASE NEW.type
  WHEN 'telegram' THEN 'telegram_bot' WHEN 'whatsapp' THEN 'meta_whatsapp_cloud'
  WHEN 'instagram' THEN 'instagram_login' WHEN 'messenger' THEN 'messenger_page' ELSE 'legacy' END
  WHERE id = NEW.id; END;
-- Once set, a provider does not change; the only exception is re-deriving the default after a type change.
CREATE TRIGGER channels_provider_immutable BEFORE UPDATE OF provider ON channels
WHEN NEW.provider IS NOT OLD.provider AND OLD.provider <> 'legacy' AND NEW.provider IS NOT CASE NEW.type
  WHEN 'telegram' THEN 'telegram_bot' WHEN 'whatsapp' THEN 'meta_whatsapp_cloud'
  WHEN 'instagram' THEN 'instagram_login' WHEN 'messenger' THEN 'messenger_page' ELSE 'legacy' END
BEGIN SELECT RAISE(ABORT, 'connection_provider_immutable'); END;
-- Existing code still writes status; keep connection_state in step until callers move to it.
CREATE TRIGGER channels_state_follows_status AFTER UPDATE OF status ON channels WHEN NEW.status IS NOT OLD.status
BEGIN UPDATE channels SET connection_state = NEW.status WHERE id = NEW.id; END;

-- Read-only name for the new concept; carries no credential column.
CREATE VIEW connections AS
  SELECT id, workspace_id, type AS kind, provider, external_id, display_name, connection_state AS status,
         settings, capabilities_override, created_at, updated_at
  FROM channels;
