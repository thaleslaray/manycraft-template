-- Lembrete por conversa: quando, nota e quem marcou. No horário a conversa reabre, fica não lida e ganha um aviso no histórico.
ALTER TABLE conversations ADD COLUMN reminder_at INTEGER;
ALTER TABLE conversations ADD COLUMN reminder_note TEXT CHECK (reminder_note IS NULL OR length(reminder_note) <= 500);
ALTER TABLE conversations ADD COLUMN reminder_by TEXT;
CREATE INDEX conversations_reminder_due ON conversations (reminder_at) WHERE reminder_at IS NOT NULL;
