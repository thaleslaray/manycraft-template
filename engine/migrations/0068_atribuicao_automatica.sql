-- Atribuição automática da Caixa de entrada.
-- basic: conversa nova sem responsável vai para o atendente com menos conversas abertas, até o limite por atendente.
-- advanced: regras em ordem (condição sobre o contato, como no filtro) mandam para um atendente ou um grupo; sem regra que case, cai no básico.
ALTER TABLE inbox_settings ADD COLUMN auto_assign TEXT NOT NULL DEFAULT 'off' CHECK (auto_assign IN ('off','basic','advanced'));
ALTER TABLE inbox_settings ADD COLUMN assign_limit INTEGER CHECK (assign_limit IS NULL OR assign_limit BETWEEN 1 AND 1000);

CREATE TABLE inbox_groups (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (workspace_id, name)
);
CREATE TABLE inbox_group_members (
  group_id TEXT NOT NULL REFERENCES inbox_groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, member_id)
);
CREATE TABLE inbox_assignment_rules (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  condition TEXT NOT NULL CHECK (json_valid(condition)),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('member','group')),
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX inbox_assignment_rules_order ON inbox_assignment_rules (workspace_id, position);
