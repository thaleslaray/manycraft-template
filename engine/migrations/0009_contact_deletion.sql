-- Extend the contact lifecycle without rebuilding the referenced parent table.
-- D1 keeps foreign_keys enabled: DROP TABLE contacts would cascade into historical
-- flow_runs/node_events even with defer_foreign_keys. Replace only the status
-- column, preserving rowids, all foreign keys, indexes and the external-content FTS.
-- SQLite permits dropping a column together with its own inline CHECK constraint:
-- https://www.sqlite.org/lang_altertable.html#alter_table_drop_column
ALTER TABLE contacts RENAME COLUMN status TO status_before_deletion;
ALTER TABLE contacts ADD COLUMN status TEXT NOT NULL DEFAULT 'subscribed'
  CHECK (status IN ('subscribed','unsubscribed','visitor','deleted'));

-- Backfill is schema maintenance; retain the original updated_at timestamps.
DROP TRIGGER contacts_updated;
UPDATE contacts SET status = status_before_deletion;
ALTER TABLE contacts DROP COLUMN status_before_deletion;
CREATE TRIGGER contacts_updated AFTER UPDATE ON contacts
WHEN NEW.updated_at IS OLD.updated_at BEGIN
  UPDATE contacts SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1) WHERE rowid = NEW.rowid;
END;
