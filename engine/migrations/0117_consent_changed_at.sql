-- Consentimento por palavra-chave (parar/voltar): horário do evento do provedor da última mudança aplicada (ms), para um START atrasado não desfazer um STOP mais novo.
ALTER TABLE contact_channels ADD COLUMN consent_changed_at INTEGER;
