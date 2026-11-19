-- Initial consent attributed at planning time; NULL means historical attribution is unknown.
ALTER TABLE flow_runs ADD COLUMN trigger_opt_in INTEGER CHECK (trigger_opt_in IN (0,1));
CREATE INDEX flow_runs_trigger_metrics ON flow_runs(workspace_id,trigger_id,created_at,contact_id);
CREATE INDEX node_events_run_metric ON node_events(workspace_id,flow_run_id,type,contact_id);
-- Only a newly recorded initial consent is attributable; an old opted-in contact
-- receiving its first imported inbound marker must not become a new opt-in.
ALTER TABLE contact_channels ADD COLUMN initial_opt_in_event_id TEXT;
CREATE TRIGGER contact_channels_initial_opt_in_insert AFTER INSERT ON contact_channels
WHEN NEW.opted_in=1 AND NEW.first_inbound_id IS NOT NULL
BEGIN
  UPDATE contact_channels SET initial_opt_in_event_id=NEW.first_inbound_id WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
END;
CREATE TRIGGER contact_channels_initial_opt_in_update AFTER UPDATE OF opted_in,first_inbound_id ON contact_channels
WHEN OLD.opted_in=0 AND NEW.opted_in=1 AND OLD.first_inbound_id IS NULL AND NEW.first_inbound_id IS NOT NULL
BEGIN
  UPDATE contact_channels SET initial_opt_in_event_id=NEW.first_inbound_id WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
END;
