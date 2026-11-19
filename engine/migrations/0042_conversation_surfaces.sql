CREATE TABLE conversation_surfaces (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('conversation_starters','main_menu')),
  draft TEXT NOT NULL,
  published TEXT,
  published_at INTEGER,
  publishing INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(workspace_id,connection_id,kind),
  FOREIGN KEY(workspace_id,connection_id) REFERENCES channels(workspace_id,id)
);
CREATE TABLE surface_firings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  inbound_id TEXT NOT NULL REFERENCES inbound_events(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  PRIMARY KEY(workspace_id,inbound_id),
  FOREIGN KEY(workspace_id,connection_id,kind) REFERENCES conversation_surfaces(workspace_id,connection_id,kind) ON DELETE CASCADE
);
