-- Modelos instalados: qual modelo virou qual automação, em que versão e quem instalou (Configurações › Modelos instalados).
CREATE TABLE template_installs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  automation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  installed_at INTEGER NOT NULL
);
CREATE INDEX template_installs_workspace ON template_installs(workspace_id, installed_at);
