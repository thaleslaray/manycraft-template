-- Immutable email content selected in the original broadcast editor.
ALTER TABLE broadcasts ADD COLUMN email_content TEXT CHECK (email_content IS NULL OR json_valid(email_content));
