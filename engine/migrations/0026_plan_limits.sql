-- Limites de estudo: Free 4 automações e 3 regras customizadas; pagos sem teto.
-- Regras reservadas e condições filhas não consomem uma nova palavra-chave.
ALTER TABLE plan_limits ADD COLUMN max_active_automations INTEGER CHECK(max_active_automations IS NULL OR max_active_automations >= 0);
ALTER TABLE plan_limits ADD COLUMN max_keywords INTEGER CHECK(max_keywords IS NULL OR max_keywords >= 0);
UPDATE plan_limits SET max_active_automations=4,max_keywords=3 WHERE plan='free';
CREATE TABLE active_contact_usage (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cycle_start TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  first_active_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,cycle_start,contact_id)
);
-- O registro sobrevive à exclusão do contato: excluir não devolve cota no ciclo.
CREATE TABLE plan_alerts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cycle_start TEXT NOT NULL,
  threshold INTEGER NOT NULL CHECK(threshold IN (70,90,100)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,cycle_start,threshold)
);
CREATE TABLE plan_contact_blocks (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cycle_start TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,cycle_start,contact_id)
);

CREATE TRIGGER plan_active_automations_insert BEFORE INSERT ON automations
WHEN NEW.status='live' AND NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT,'PLAN_ACTIVE_AUTOMATIONS_LIMIT') WHERE
    (SELECT count(*) FROM automations WHERE workspace_id=NEW.workspace_id AND status='live'
      AND deleted_at IS NULL AND id<>NEW.id) >=
    (SELECT p.max_active_automations FROM plan_limits p JOIN workspaces w ON w.plan=p.plan WHERE w.id=NEW.workspace_id);
END;

CREATE TRIGGER plan_active_automations_update BEFORE UPDATE ON automations
WHEN NEW.status='live' AND NEW.deleted_at IS NULL
  AND (OLD.status<>'live' OR OLD.deleted_at IS NOT NULL OR OLD.workspace_id<>NEW.workspace_id)
BEGIN
  SELECT RAISE(ABORT,'PLAN_ACTIVE_AUTOMATIONS_LIMIT') WHERE
    (SELECT count(*) FROM automations WHERE workspace_id=NEW.workspace_id AND status='live'
      AND deleted_at IS NULL AND id<>NEW.id) >=
    (SELECT p.max_active_automations FROM plan_limits p JOIN workspaces w ON w.plan=p.plan WHERE w.id=NEW.workspace_id);
END;

CREATE TRIGGER plan_keywords_insert BEFORE INSERT ON keywords
WHEN NEW.status='live' AND NEW.parent_id IS NULL AND NEW.is_reserved=0
BEGIN
  SELECT RAISE(ABORT,'PLAN_KEYWORDS_LIMIT') WHERE
    (SELECT count(*) FROM keywords WHERE workspace_id=NEW.workspace_id AND status='live'
      AND parent_id IS NULL AND is_reserved=0 AND id<>NEW.id) >=
    (SELECT p.max_keywords FROM plan_limits p JOIN workspaces w ON w.plan=p.plan WHERE w.id=NEW.workspace_id);
END;

CREATE TRIGGER plan_keywords_update BEFORE UPDATE ON keywords
WHEN NEW.status='live' AND NEW.parent_id IS NULL AND NEW.is_reserved=0
  AND (OLD.status<>'live' OR OLD.parent_id IS NOT NULL OR OLD.is_reserved<>0 OR OLD.workspace_id<>NEW.workspace_id)
BEGIN
  SELECT RAISE(ABORT,'PLAN_KEYWORDS_LIMIT') WHERE
    (SELECT count(*) FROM keywords WHERE workspace_id=NEW.workspace_id AND status='live'
      AND parent_id IS NULL AND is_reserved=0 AND id<>NEW.id) >=
    (SELECT p.max_keywords FROM plan_limits p JOIN workspaces w ON w.plan=p.plan WHERE w.id=NEW.workspace_id);
END;
