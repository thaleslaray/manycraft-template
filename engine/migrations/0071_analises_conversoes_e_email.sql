-- Análises: moeda da conversão (receita por moeda), quando o contato passou a ter e-mail (e-mails coletados no período)
-- e quando a conversa foi encerrada (tempo até encerrar na análise da Caixa de entrada).
ALTER TABLE conversion_events ADD COLUMN currency TEXT NOT NULL DEFAULT 'BRL' CHECK (currency IN ('BRL','USD','EUR'));
ALTER TABLE contacts ADD COLUMN email_collected_at INTEGER;
ALTER TABLE conversations ADD COLUMN closed_at INTEGER;
CREATE INDEX conversion_events_workspace_time ON conversion_events (workspace_id, created_at);
ALTER TABLE contacts ADD COLUMN unsubscribed_at INTEGER;

-- Os instantes nascem no banco: vale para todo caminho que muda o status, o e-mail ou a conversa.
CREATE TRIGGER contacts_unsubscribed_at AFTER UPDATE OF status ON contacts
WHEN NEW.status = 'unsubscribed' AND OLD.status <> 'unsubscribed'
BEGIN UPDATE contacts SET unsubscribed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE rowid = NEW.rowid; END;
CREATE TRIGGER contacts_email_collected_update AFTER UPDATE OF email ON contacts
WHEN OLD.email IS NULL AND NEW.email IS NOT NULL
BEGIN UPDATE contacts SET email_collected_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE rowid = NEW.rowid; END;
CREATE TRIGGER contacts_email_collected_insert AFTER INSERT ON contacts
WHEN NEW.email IS NOT NULL
BEGIN UPDATE contacts SET email_collected_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE rowid = NEW.rowid; END;
CREATE TRIGGER conversations_closed_at AFTER UPDATE OF status ON conversations
WHEN NEW.status <> OLD.status
BEGIN UPDATE conversations SET closed_at = CASE WHEN NEW.status = 'closed' THEN CAST(unixepoch('subsec') * 1000 AS INTEGER) ELSE NULL END WHERE rowid = NEW.rowid; END;
