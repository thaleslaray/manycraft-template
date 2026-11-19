-- A broadcast owns its graph; later source edits/publications cannot change this copy.
ALTER TABLE broadcasts ADD COLUMN copied_graph TEXT CHECK(copied_graph IS NULL OR json_valid(copied_graph));
ALTER TABLE broadcasts ADD COLUMN source_automation_id TEXT;
ALTER TABLE broadcasts ADD COLUMN first_node_id TEXT;
