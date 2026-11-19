-- Configurações: organização persistente dos campos e das tags por workspace.
CREATE TABLE settings_folders (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('fields','tags')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id,kind,name),
  UNIQUE (workspace_id,id)
);
ALTER TABLE custom_fields ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1));
ALTER TABLE custom_fields ADD COLUMN folder_id TEXT REFERENCES settings_folders(id) ON DELETE SET NULL;
ALTER TABLE tags ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1));
ALTER TABLE tags ADD COLUMN folder_id TEXT REFERENCES settings_folders(id) ON DELETE SET NULL;
CREATE INDEX settings_folders_workspace ON settings_folders(workspace_id,kind);
-- Mantém a barreira de tenant mesmo para outras entradas que gravem diretamente no D1.
CREATE TRIGGER custom_fields_folder_insert BEFORE INSERT ON custom_fields
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM settings_folders WHERE id=NEW.folder_id AND workspace_id=NEW.workspace_id AND kind='fields'
) BEGIN SELECT RAISE(ABORT,'Invalid field folder'); END;
CREATE TRIGGER custom_fields_folder_update BEFORE UPDATE OF folder_id,workspace_id ON custom_fields
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM settings_folders WHERE id=NEW.folder_id AND workspace_id=NEW.workspace_id AND kind='fields'
) BEGIN SELECT RAISE(ABORT,'Invalid field folder'); END;
CREATE TRIGGER tags_folder_insert BEFORE INSERT ON tags
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM settings_folders WHERE id=NEW.folder_id AND workspace_id=NEW.workspace_id AND kind='tags'
) BEGIN SELECT RAISE(ABORT,'Invalid tag folder'); END;
CREATE TRIGGER tags_folder_update BEFORE UPDATE OF folder_id,workspace_id ON tags
WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM settings_folders WHERE id=NEW.folder_id AND workspace_id=NEW.workspace_id AND kind='tags'
) BEGIN SELECT RAISE(ABORT,'Invalid tag folder'); END;
