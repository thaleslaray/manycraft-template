-- Instagram só pelo login unificado: o provedor 'instagram_login' (graph.instagram.com) sai do produto.
-- Apaga as conexões Instagram 'instagram_login' e também as 'legacy' (sem provedor gravado): depois desta migração o padrão do canal
-- vira 'instagram_unified' e elas passariam a falar com o login unificado usando o token do login antigo, que ele não aceita.
-- Saem junto, em cascata pelas chaves estrangeiras, contact_channels > conversas > mensagens, gatilhos, execuções (e comment_effects),
-- transmissões etc.; as tabelas que guardam o id do canal sem chave são limpas antes, à mão. Os contatos ficam, sem esse canal.
-- Depois refaz a coluna provider sem o valor (mesma reconstrução da 0116, preservando identidades, FKs e rowids).
DELETE FROM inbound_media WHERE channel_id IN (SELECT id FROM channels WHERE type = 'instagram' AND provider IN ('instagram_login','legacy'));
DELETE FROM notification_topics WHERE channel_id IN (SELECT id FROM channels WHERE type = 'instagram' AND provider IN ('instagram_login','legacy'));
DELETE FROM message_callbacks WHERE channel_id IN (SELECT id FROM channels WHERE type = 'instagram' AND provider IN ('instagram_login','legacy'));
DELETE FROM trigger_follow_ups WHERE channel_id IN (SELECT id FROM channels WHERE type = 'instagram' AND provider IN ('instagram_login','legacy'));
DELETE FROM alert_chat_codes WHERE channel_id IN (SELECT id FROM channels WHERE type = 'instagram' AND provider IN ('instagram_login','legacy'));
UPDATE member_alert_settings SET chat_channel_id = NULL, chat_id = NULL WHERE chat_channel_id IN (SELECT id FROM channels WHERE type = 'instagram' AND provider IN ('instagram_login','legacy'));
DELETE FROM channels WHERE type = 'instagram' AND provider IN ('instagram_login','legacy');

DROP VIEW connections;
DROP TRIGGER channels_provider_kind;
DROP TRIGGER channels_provider_kind_update;
DROP TRIGGER channels_provider_default;
DROP TRIGGER channels_provider_follows_type;
DROP TRIGGER channels_provider_immutable;
DROP TRIGGER whatsapp_identity_insert;
DROP TRIGGER whatsapp_identity_update;
DROP TRIGGER channels_updated;

ALTER TABLE channels RENAME COLUMN provider TO provider_before_so_unificado;
ALTER TABLE channels ADD COLUMN provider TEXT NOT NULL DEFAULT 'legacy'
  CHECK (provider IN ('legacy','meta_whatsapp_cloud','uazapi','zapi','cloudflare_email','twilio_sms','telegram_bot','instagram_unified','messenger_page'));
UPDATE channels SET provider = provider_before_so_unificado;
ALTER TABLE channels DROP COLUMN provider_before_so_unificado;

CREATE TRIGGER channels_updated AFTER UPDATE ON channels
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE channels SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

-- A provider only serves the channels it declares (mirrors ProviderAdapter.kinds; the registry test checks both).
CREATE TRIGGER channels_provider_kind BEFORE INSERT ON channels
WHEN NOT ((NEW.provider = 'legacy') OR (NEW.provider IN ('meta_whatsapp_cloud','uazapi','zapi') AND NEW.type = 'whatsapp')
  OR (NEW.provider = 'telegram_bot' AND NEW.type = 'telegram') OR (NEW.provider = 'instagram_unified' AND NEW.type = 'instagram')
  OR (NEW.provider = 'messenger_page' AND NEW.type = 'messenger') OR (NEW.provider = 'cloudflare_email' AND NEW.type = 'email') OR (NEW.provider = 'twilio_sms' AND NEW.type = 'sms'))
BEGIN SELECT RAISE(ABORT, 'provider_kind_mismatch'); END;
CREATE TRIGGER channels_provider_kind_update BEFORE UPDATE OF provider ON channels
WHEN NOT ((NEW.provider = 'legacy') OR (NEW.provider IN ('meta_whatsapp_cloud','uazapi','zapi') AND NEW.type = 'whatsapp')
  OR (NEW.provider = 'telegram_bot' AND NEW.type = 'telegram') OR (NEW.provider = 'instagram_unified' AND NEW.type = 'instagram')
  OR (NEW.provider = 'messenger_page' AND NEW.type = 'messenger') OR (NEW.provider = 'cloudflare_email' AND NEW.type = 'email') OR (NEW.provider = 'twilio_sms' AND NEW.type = 'sms'))
BEGIN SELECT RAISE(ABORT, 'provider_kind_mismatch'); END;
CREATE TRIGGER channels_provider_default AFTER INSERT ON channels WHEN NEW.provider = 'legacy'
BEGIN UPDATE channels SET provider = CASE NEW.type
  WHEN 'telegram' THEN 'telegram_bot' WHEN 'whatsapp' THEN 'meta_whatsapp_cloud'
  WHEN 'email' THEN 'cloudflare_email' WHEN 'sms' THEN 'twilio_sms' WHEN 'instagram' THEN 'instagram_unified' WHEN 'messenger' THEN 'messenger_page' ELSE 'legacy' END
  WHERE id = NEW.id; END;
CREATE TRIGGER channels_provider_follows_type AFTER UPDATE OF type ON channels WHEN NEW.type IS NOT OLD.type
BEGIN UPDATE channels SET provider = CASE NEW.type
  WHEN 'telegram' THEN 'telegram_bot' WHEN 'whatsapp' THEN 'meta_whatsapp_cloud'
  WHEN 'email' THEN 'cloudflare_email' WHEN 'sms' THEN 'twilio_sms' WHEN 'instagram' THEN 'instagram_unified' WHEN 'messenger' THEN 'messenger_page' ELSE 'legacy' END
  WHERE id = NEW.id; END;
CREATE TRIGGER channels_provider_immutable BEFORE UPDATE OF provider ON channels
WHEN NEW.provider IS NOT OLD.provider AND OLD.provider <> 'legacy' AND NEW.provider IS NOT CASE NEW.type
  WHEN 'telegram' THEN 'telegram_bot' WHEN 'whatsapp' THEN 'meta_whatsapp_cloud'
  WHEN 'email' THEN 'cloudflare_email' WHEN 'sms' THEN 'twilio_sms' WHEN 'instagram' THEN 'instagram_unified' WHEN 'messenger' THEN 'messenger_page' ELSE 'legacy' END
BEGIN SELECT RAISE(ABORT, 'connection_provider_immutable'); END;

-- Identity of a WhatsApp contact. The official provider needs a BSUID; UAZAPI brings a JID (phone or LID); Z-API brings the phone in digits
-- (Omni's `sender.identifier`, the same form `recipient.identifier` takes on send).
CREATE TRIGGER whatsapp_identity_insert BEFORE INSERT ON contact_channels
WHEN (EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id AND type = 'whatsapp' AND provider NOT IN ('uazapi','zapi'))
  AND NOT (NEW.identity_kind = 'wa_phone_legacy' AND length(NEW.external_user_id) BETWEEN 7 AND 15 AND NEW.external_user_id NOT GLOB '*[^0-9]*'
    AND EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id AND provider = 'meta_whatsapp_cloud'))
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
CREATE TRIGGER whatsapp_identity_update BEFORE UPDATE OF workspace_id,channel_id,contact_id,external_user_id,identity_kind ON contact_channels
WHEN (EXISTS (SELECT 1 FROM channels WHERE id=OLD.channel_id AND type='whatsapp')
  AND NOT (OLD.identity_kind='wa_phone_legacy' AND NEW.identity_kind='bsuid' AND NEW.workspace_id IS OLD.workspace_id
    AND NEW.channel_id IS OLD.channel_id AND NEW.contact_id IS OLD.contact_id
    AND EXISTS (SELECT 1 FROM channels WHERE id=OLD.channel_id AND provider='meta_whatsapp_cloud'))
  AND (NEW.workspace_id IS NOT OLD.workspace_id OR NEW.channel_id IS NOT OLD.channel_id
    OR NEW.external_user_id IS NOT OLD.external_user_id OR NEW.identity_kind IS NOT OLD.identity_kind
    OR (NEW.contact_id IS NOT OLD.contact_id AND NOT EXISTS (SELECT 1 FROM contact_merges m
      WHERE m.workspace_id=OLD.workspace_id AND m.secondary_id=OLD.contact_id AND m.primary_id=NEW.contact_id))))
  OR (EXISTS (SELECT 1 FROM channels WHERE id=NEW.channel_id AND type='whatsapp')
    AND NOT EXISTS (SELECT 1 FROM channels WHERE id=OLD.channel_id AND type='whatsapp'))
  OR (NEW.identity_kind!='provider_id' AND NOT EXISTS (SELECT 1 FROM channels WHERE id=NEW.channel_id AND type='whatsapp'))
BEGIN SELECT RAISE(ABORT,'whatsapp_identity_immutable'); END;

CREATE VIEW connections AS
  SELECT id, workspace_id, type AS kind, provider, external_id, display_name, connection_state AS status,
         status_detail, settings, capabilities_override, webhook_mode, webhook_registered_at, archived_at,
         credentials_rotated_at AS rotated_at, created_at, updated_at
  FROM channels;
