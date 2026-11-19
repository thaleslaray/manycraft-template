-- One live collection per contact and connection; immutable configuration belongs to its published run.
CREATE TABLE flow_questions (
  run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  config TEXT NOT NULL CHECK(json_valid(config)),
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','success','no_response','stopped')),
  PRIMARY KEY(run_id,step_index),
  FOREIGN KEY(workspace_id,run_id) REFERENCES flow_runs(workspace_id,id),
  FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id),
  FOREIGN KEY(workspace_id,channel_id) REFERENCES channels(workspace_id,id)
);
CREATE UNIQUE INDEX flow_questions_active ON flow_questions(workspace_id,contact_id,channel_id) WHERE status='open';
CREATE TABLE flow_question_answers (
  inbound_event_id TEXT PRIMARY KEY REFERENCES inbound_events(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('retry','success','no_response','stopped')),
  delivered_at INTEGER,
  UNIQUE(run_id,step_index,attempt),
  FOREIGN KEY(run_id,step_index) REFERENCES flow_questions(run_id,step_index) ON DELETE CASCADE
);
