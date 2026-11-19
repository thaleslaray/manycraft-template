-- Stable keyset order for both the library and its trash, scoped to the workspace.
CREATE INDEX automations_library_cursor ON automations(workspace_id, updated_at DESC, id DESC);
CREATE INDEX triggers_library_filter ON triggers(workspace_id, automation_id, status, kind);

-- Protect the tree even when two folder moves race after application validation.
CREATE TRIGGER folders_no_cycle BEFORE UPDATE OF parent_id ON folders
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'folder_cycle') WHERE NEW.parent_id IN (
    WITH RECURSIVE descendants(id) AS (
      SELECT OLD.id UNION
      SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id
      WHERE f.workspace_id=OLD.workspace_id
    ) SELECT id FROM descendants
  );
END;
