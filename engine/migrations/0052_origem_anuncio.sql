-- Origem de anúncio no contato: a primeira mensagem que chega de um anúncio grava de onde veio (modelo neutro, vale para qualquer canal).
-- Só a primeira origem fica; `ad_referred_at` (ms) marca quando ela chegou e serve de trava.
ALTER TABLE contacts ADD COLUMN ad_source_id TEXT;
ALTER TABLE contacts ADD COLUMN ad_source_type TEXT;
ALTER TABLE contacts ADD COLUMN ad_headline TEXT;
ALTER TABLE contacts ADD COLUMN ad_click_id TEXT;
ALTER TABLE contacts ADD COLUMN ad_source_url TEXT;
ALTER TABLE contacts ADD COLUMN ad_referred_at INTEGER;
