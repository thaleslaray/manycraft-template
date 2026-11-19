-- Frozen story context of a run born from a story mention: the message to react to, the pause before the first reply and whether to send the heart.
ALTER TABLE flow_runs ADD COLUMN story_context TEXT CHECK (story_context IS NULL OR json_valid(story_context));
