-- Links belong to the frozen first message and never consume a flow callback.
CREATE TABLE broadcast_links (
  token TEXT PRIMARY KEY CHECK(length(token)=32),
  workspace_id TEXT NOT NULL,
  broadcast_id TEXT NOT NULL,
  contact_channel_id TEXT NOT NULL,
  button_id TEXT NOT NULL,
  target_url TEXT NOT NULL,
  clicked_at INTEGER,
  UNIQUE(broadcast_id,contact_channel_id,button_id),
  FOREIGN KEY(workspace_id,broadcast_id) REFERENCES broadcasts(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(broadcast_id,contact_channel_id) REFERENCES broadcast_recipients(broadcast_id,contact_channel_id) ON DELETE CASCADE
);
