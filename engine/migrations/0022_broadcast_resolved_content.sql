-- Preserve exactly what each recipient received across retries and history recovery.
ALTER TABLE broadcast_recipients ADD COLUMN resolved_content TEXT;
