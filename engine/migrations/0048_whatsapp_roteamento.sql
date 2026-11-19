-- Conversation Routing da API oficial do WhatsApp: quem é o dono de cada conversa (avisos do campo messaging_handovers e ações pass/release/take).
-- owner_role NULL = conversa ociosa (release). updated_at é o horário da Meta (ms): um aviso atrasado não desfaz um mais novo.
CREATE TABLE whatsapp_thread_owners (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  owner_role TEXT,
  previous_role TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, channel_id, external_user_id),
  FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE
);

-- Conversa iniciada pela caixa de entrada com um número que nunca escreveu: ainda não há BSUID, só o telefone (wa_phone_legacy).
-- Quando a pessoa responder, a mesma linha é promovida a BSUID (a conversa, o consentimento e o histórico ficam onde estão).
DROP TRIGGER whatsapp_identity_insert;
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

DROP TRIGGER whatsapp_identity_update;
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
