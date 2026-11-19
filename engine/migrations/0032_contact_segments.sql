-- Reuse the segment entity created in 0001; saved audiences remain dynamic filters.
CREATE UNIQUE INDEX segments_name_unique ON segments (workspace_id, name COLLATE NOCASE);
