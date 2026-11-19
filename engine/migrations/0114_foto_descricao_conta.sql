-- Foto (arquivo já enviado pelo envio de mídia) e descrição curta da conta, editadas em Configurações > Geral.
ALTER TABLE workspaces ADD COLUMN photo_media_id TEXT REFERENCES media_objects(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN description TEXT CHECK (description IS NULL OR length(description) <= 280);
