-- Pausa de uma automação só para um contato (ação "Pausar automações" com escopo): runs novos dela não começam até o prazo.
CREATE TABLE contact_automation_pauses (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  paused_until INTEGER NOT NULL,
  PRIMARY KEY (contact_id, automation_id),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) ON DELETE CASCADE
);
