-- O contato bloqueou a página ou apagou a conversa: o provedor recusa o envio com "bloqueado".
-- Fica no vínculo do canal (é por página/conta); a próxima mensagem dele limpa a marca.
ALTER TABLE contact_channels ADD COLUMN blocked_at INTEGER;
