-- Visible checkpoint for the consecutive-block safety pause. Graph additions stay in version snapshots.
ALTER TABLE flow_runs ADD COLUMN steps_since_pause INTEGER NOT NULL DEFAULT 0 CHECK (steps_since_pause >= 0);
