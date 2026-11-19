-- An explicit merge is the sole exception to immutable identity ownership.
-- Keep the authorization in D1 so the reparent and every other merge change commit together.
CREATE TABLE contact_merges (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  secondary_id TEXT NOT NULL PRIMARY KEY,
  primary_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (secondary_id <> primary_id),
  FOREIGN KEY(workspace_id,secondary_id) REFERENCES contacts(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,primary_id) REFERENCES contacts(workspace_id,id) ON DELETE CASCADE
);
CREATE TRIGGER contact_merge_validate BEFORE INSERT ON contact_merges BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM contacts WHERE workspace_id=NEW.workspace_id
    AND id IN (NEW.primary_id,NEW.secondary_id) AND status<>'deleted')<>2
    THEN RAISE(ABORT,'merge_contact_unavailable') END;
  SELECT CASE WHEN EXISTS (SELECT ch.type FROM contact_channels cc JOIN channels ch
    ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
    WHERE cc.workspace_id=NEW.workspace_id AND cc.contact_id IN (NEW.primary_id,NEW.secondary_id)
    GROUP BY ch.type HAVING count(*)>1)
    THEN RAISE(ABORT,'merge_channel_conflict') END;
END;
DROP TRIGGER whatsapp_identity_update;
CREATE TRIGGER whatsapp_identity_update BEFORE UPDATE OF workspace_id,channel_id,contact_id,external_user_id,identity_kind ON contact_channels
WHEN (EXISTS (SELECT 1 FROM channels WHERE id=OLD.channel_id AND type='whatsapp')
  AND (NEW.workspace_id IS NOT OLD.workspace_id OR NEW.channel_id IS NOT OLD.channel_id
    OR NEW.external_user_id IS NOT OLD.external_user_id OR NEW.identity_kind IS NOT OLD.identity_kind
    OR (NEW.contact_id IS NOT OLD.contact_id AND NOT EXISTS (SELECT 1 FROM contact_merges m
      WHERE m.workspace_id=OLD.workspace_id AND m.secondary_id=OLD.contact_id AND m.primary_id=NEW.contact_id))))
  OR (EXISTS (SELECT 1 FROM channels WHERE id=NEW.channel_id AND type='whatsapp')
    AND NOT EXISTS (SELECT 1 FROM channels WHERE id=OLD.channel_id AND type='whatsapp'))
  OR (NEW.identity_kind!='provider_id' AND NOT EXISTS (SELECT 1 FROM channels WHERE id=NEW.channel_id AND type='whatsapp'))
BEGIN SELECT RAISE(ABORT,'whatsapp_identity_immutable'); END;
