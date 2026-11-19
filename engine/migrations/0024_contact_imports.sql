ALTER TABLE contacts ADD COLUMN email TEXT;
ALTER TABLE contacts ADD COLUMN phone TEXT CHECK (phone IS NULL OR (length(phone) BETWEEN 7 AND 15 AND phone NOT GLOB '*[^0-9]*'));
CREATE UNIQUE INDEX contacts_workspace_email ON contacts(workspace_id,email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX contacts_workspace_phone ON contacts(workspace_id,phone) WHERE phone IS NOT NULL;
-- The existing erasure journey must also erase these new system fields.
CREATE TRIGGER contacts_erase_addresses AFTER UPDATE OF status ON contacts
WHEN NEW.status='deleted' BEGIN
  UPDATE contacts SET email=NULL,phone=NULL WHERE id=NEW.id;
END;

CREATE TABLE contact_imports (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading','queued','processing','completed','failed')),
  total INTEGER NOT NULL,
  header_count INTEGER NOT NULL,
  mapping TEXT NOT NULL CHECK (json_valid(mapping)),
  tag_ids TEXT NOT NULL CHECK (json_valid(tag_ids)),
  consent_confirmed_at INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id,id)
);
CREATE TABLE contact_import_rows (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES contact_imports(id) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  cells TEXT NOT NULL CHECK (json_valid(cells)),
  outcome TEXT CHECK (outcome IN ('created','updated','ignored')),
  reason TEXT,
  PRIMARY KEY(import_id,line),
  FOREIGN KEY(workspace_id,import_id) REFERENCES contact_imports(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX contact_import_rows_pending ON contact_import_rows(import_id,outcome,line);
