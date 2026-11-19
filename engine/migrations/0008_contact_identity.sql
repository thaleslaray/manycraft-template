-- W7: identity is provider-assigned; never manufacture a BSUID from a phone.
-- Additive migration: retain old keys/relations, quarantine unverified WA identities.
ALTER TABLE contact_channels ADD COLUMN identity_kind TEXT NOT NULL DEFAULT 'provider_id'
  CHECK(identity_kind IN ('provider_id','bsuid','wa_phone_legacy'));
ALTER TABLE contact_channels ADD COLUMN phone_e164 TEXT CHECK(phone_e164 IS NULL OR (length(phone_e164) BETWEEN 8 AND 16 AND substr(phone_e164, 1, 2) GLOB '+[1-9]'
  AND substr(phone_e164, 2) NOT GLOB '*[^0-9]*'));
ALTER TABLE contact_channels ADD COLUMN sms_provider_blocked_at INTEGER
  CHECK(sms_provider_blocked_at IS NULL OR (typeof(sms_provider_blocked_at) = 'integer' AND sms_provider_blocked_at >= 0));
ALTER TABLE contact_channels ADD COLUMN window_messages_sent INTEGER NOT NULL DEFAULT 0
  CHECK(typeof(window_messages_sent) = 'integer' AND window_messages_sent BETWEEN 0 AND 10);

-- Preserve original updated_at during this metadata-only backfill.
DROP TRIGGER contact_channels_updated;
UPDATE contact_channels SET identity_kind = 'wa_phone_legacy'
WHERE channel_id IN (SELECT id FROM channels WHERE type = 'whatsapp');
CREATE TRIGGER contact_channels_updated AFTER UPDATE ON contact_channels
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE contact_channels SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;

CREATE UNIQUE INDEX contact_channels_identity_parent ON contact_channels(workspace_id, id, channel_id);
CREATE TABLE contact_identity_aliases (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  alias_kind TEXT NOT NULL DEFAULT 'phone_e164' CHECK(alias_kind = 'phone_e164'),
  alias_value TEXT NOT NULL CHECK(length(alias_value) BETWEEN 8 AND 16
    AND substr(alias_value, 1, 2) GLOB '+[1-9]' AND substr(alias_value, 2) NOT GLOB '*[^0-9]*'),
  contact_channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY(channel_id, alias_kind, alias_value),
  FOREIGN KEY(workspace_id, contact_channel_id, channel_id)
    REFERENCES contact_channels(workspace_id, id, channel_id) ON DELETE CASCADE
);
CREATE INDEX contact_identity_aliases_contact ON contact_identity_aliases(workspace_id, contact_channel_id);

CREATE TRIGGER whatsapp_identity_insert BEFORE INSERT ON contact_channels
WHEN (EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id AND type = 'whatsapp')
  AND (NEW.identity_kind != 'bsuid' OR NOT ((substr(NEW.external_user_id, 1, 3) GLOB '[A-Z][A-Z].'
  AND length(substr(NEW.external_user_id, 4)) BETWEEN 1 AND 128
  AND substr(NEW.external_user_id, 4) NOT GLOB '*[^A-Za-z0-9]*')
  OR (substr(NEW.external_user_id, 1, 7) GLOB '[A-Z][A-Z].ENT.'
  AND length(substr(NEW.external_user_id, 8)) BETWEEN 1 AND 128
  AND substr(NEW.external_user_id, 8) NOT GLOB '*[^A-Za-z0-9]*'))))
  OR (NEW.identity_kind != 'provider_id' AND NOT EXISTS
    (SELECT 1 FROM channels WHERE id = NEW.channel_id AND type = 'whatsapp'))
BEGIN SELECT RAISE(ABORT, 'whatsapp_requires_bsuid'); END;

-- Identity bindings are immutable, including legacy rows. A verified BSUID is a new
-- channel identity linked explicitly to the existing contact, never a key rewrite.
CREATE TRIGGER whatsapp_identity_update BEFORE UPDATE OF workspace_id, channel_id, contact_id, external_user_id, identity_kind ON contact_channels
WHEN (EXISTS (SELECT 1 FROM channels WHERE id = OLD.channel_id AND type = 'whatsapp')
  AND (NEW.workspace_id IS NOT OLD.workspace_id OR NEW.channel_id IS NOT OLD.channel_id
    OR NEW.contact_id IS NOT OLD.contact_id OR NEW.external_user_id IS NOT OLD.external_user_id
    OR NEW.identity_kind IS NOT OLD.identity_kind))
  OR (EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id AND type = 'whatsapp')
    AND NOT EXISTS (SELECT 1 FROM channels WHERE id = OLD.channel_id AND type = 'whatsapp'))
  OR (NEW.identity_kind != 'provider_id' AND NOT EXISTS
    (SELECT 1 FROM channels WHERE id = NEW.channel_id AND type = 'whatsapp'))
BEGIN SELECT RAISE(ABORT, 'whatsapp_identity_immutable'); END;

CREATE TRIGGER channel_identity_type_update BEFORE UPDATE OF type ON channels
WHEN NEW.type != OLD.type AND (NEW.type = 'whatsapp' OR OLD.type = 'whatsapp') AND EXISTS (SELECT 1 FROM contact_channels WHERE channel_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'channel_with_identities_type_immutable'); END;

CREATE TRIGGER identity_alias_insert BEFORE INSERT ON contact_identity_aliases
WHEN NOT EXISTS (SELECT 1 FROM contact_channels cc JOIN channels ch ON ch.id = cc.channel_id
  AND ch.workspace_id = cc.workspace_id WHERE cc.workspace_id = NEW.workspace_id
  AND cc.id = NEW.contact_channel_id AND cc.channel_id = NEW.channel_id
  AND ch.type = 'whatsapp' AND cc.identity_kind = 'bsuid')
BEGIN SELECT RAISE(ABORT, 'alias_requires_local_bsuid'); END;

CREATE TRIGGER identity_alias_update BEFORE UPDATE ON contact_identity_aliases
BEGIN SELECT RAISE(ABORT, 'identity_alias_immutable'); END;

-- Keep historical phone aliases. Reassigning an alias requires explicit reconciliation;
-- a collision aborts the whole statement/batch instead of silently merging contacts.
CREATE TRIGGER whatsapp_phone_insert AFTER INSERT ON contact_channels
WHEN NEW.identity_kind = 'bsuid' AND NEW.phone_e164 IS NOT NULL
BEGIN
  INSERT INTO contact_identity_aliases(workspace_id, channel_id, alias_value, contact_channel_id)
  VALUES(NEW.workspace_id, NEW.channel_id, NEW.phone_e164, NEW.id);
END;
CREATE TRIGGER whatsapp_phone_update AFTER UPDATE OF phone_e164 ON contact_channels
WHEN NEW.identity_kind = 'bsuid' AND NEW.phone_e164 IS NOT NULL
BEGIN
  INSERT INTO contact_identity_aliases(workspace_id, channel_id, alias_value, contact_channel_id)
  SELECT NEW.workspace_id, NEW.channel_id, NEW.phone_e164, NEW.id
  WHERE NOT EXISTS (SELECT 1 FROM contact_identity_aliases WHERE channel_id = NEW.channel_id
    AND alias_kind = 'phone_e164' AND alias_value = NEW.phone_e164 AND contact_channel_id = NEW.id);
END;
