-- Connection layer, F5 (UAZAPI): WhatsApp identity without the Meta BSUID, union by phone number, last connection used.
-- Risk 1 of replica/arquitetura-mensageria.md: 0008 demands a BSUID for ANY whatsapp channel; UAZAPI has none.
-- identity_kind keeps its CHECK (not alterable without recreating the table): UAZAPI rows use 'provider_id' plus address_kind.
ALTER TABLE contact_channels ADD COLUMN address_kind TEXT
  CHECK (address_kind IS NULL OR address_kind IN ('bsuid','wa_pn','wa_lid','igsid','psid','telegram_id','phone_e164','email'));
-- D7: the connection a contact used last answers them (the reply leaves through the row with the newest value).
ALTER TABLE contact_channels ADD COLUMN last_inbound_at INTEGER;
CREATE INDEX contact_channels_last_inbound ON contact_channels (workspace_id, contact_id, last_inbound_at DESC)
  WHERE last_inbound_at IS NOT NULL;
-- Newest provider message timestamp (ms) already queued by the reconciliation job (UAZAPI never redelivers a webhook).
ALTER TABLE channels ADD COLUMN sync_cursor INTEGER;

-- The BSUID rule now binds the official provider only; a non official provider must bring a JID (phone or LID).
DROP TRIGGER whatsapp_identity_insert;
CREATE TRIGGER whatsapp_identity_insert BEFORE INSERT ON contact_channels
WHEN (EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id AND type = 'whatsapp' AND provider <> 'uazapi')
  AND (NEW.identity_kind != 'bsuid' OR NOT ((substr(NEW.external_user_id, 1, 3) GLOB '[A-Z][A-Z].'
  AND length(substr(NEW.external_user_id, 4)) BETWEEN 1 AND 128
  AND substr(NEW.external_user_id, 4) NOT GLOB '*[^A-Za-z0-9]*')
  OR (substr(NEW.external_user_id, 1, 7) GLOB '[A-Z][A-Z].ENT.'
  AND length(substr(NEW.external_user_id, 8)) BETWEEN 1 AND 128
  AND substr(NEW.external_user_id, 8) NOT GLOB '*[^A-Za-z0-9]*'))))
  OR (EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id AND type = 'whatsapp' AND provider = 'uazapi')
  AND (NEW.identity_kind != 'provider_id' OR coalesce(NEW.address_kind, '') NOT IN ('wa_pn','wa_lid')
    OR NOT (NEW.external_user_id GLOB '[0-9]*@s.whatsapp.net' OR NEW.external_user_id GLOB '[0-9]*@lid')))
  OR (NEW.identity_kind != 'provider_id' AND NOT EXISTS
    (SELECT 1 FROM channels WHERE id = NEW.channel_id AND type = 'whatsapp'))
BEGIN SELECT RAISE(ABORT, 'whatsapp_requires_bsuid'); END;

-- Union by number (D6): one row per workspace and number, whoever inserts first wins the race. Only a number the provider
-- itself asserted enters here (Cloud wa_id, UAZAPI @s.whatsapp.net); a LID alone never unites. Other channels never enter.
CREATE TABLE whatsapp_numbers (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  phone_e164 TEXT NOT NULL CHECK (length(phone_e164) BETWEEN 8 AND 16 AND substr(phone_e164, 1, 2) GLOB '+[1-9]'
    AND substr(phone_e164, 2) NOT GLOB '*[^0-9]*'),
  contact_id TEXT NOT NULL,
  first_connection_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (workspace_id, phone_e164),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, first_connection_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX whatsapp_numbers_contact ON whatsapp_numbers (workspace_id, contact_id);
-- Numbers the official provider already holds keep their contact (oldest identity wins).
INSERT OR IGNORE INTO whatsapp_numbers (workspace_id, phone_e164, contact_id, first_connection_id, created_at)
SELECT cc.workspace_id, cc.phone_e164, cc.contact_id, cc.channel_id, cc.created_at
FROM contact_channels cc JOIN channels ch ON ch.workspace_id = cc.workspace_id AND ch.id = cc.channel_id
JOIN contacts c ON c.workspace_id = cc.workspace_id AND c.id = cc.contact_id
WHERE ch.type = 'whatsapp' AND cc.phone_e164 IS NOT NULL AND c.status <> 'deleted'
ORDER BY cc.created_at, cc.id;
-- Erasure keeps the contact row (status 'deleted') but must not keep the person's number.
CREATE TRIGGER whatsapp_numbers_erased AFTER UPDATE OF status ON contacts
WHEN NEW.status = 'deleted' AND OLD.status <> 'deleted'
BEGIN DELETE FROM whatsapp_numbers WHERE workspace_id = NEW.workspace_id AND contact_id = NEW.id; END;
