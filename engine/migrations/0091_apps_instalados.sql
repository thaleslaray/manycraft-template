-- Dev Program (estudo): app descrito por JSON (auth, actions, sources) instalado no espaço; os parâmetros de auth ficam cifrados.
CREATE TABLE installed_apps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  spec TEXT NOT NULL CHECK (json_valid(spec)),
  ciphertext TEXT,
  iv TEXT,
  key_version INTEGER,
  installed_by TEXT,
  created_at INTEGER NOT NULL
);
