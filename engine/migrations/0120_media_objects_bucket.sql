-- Em qual bucket R2 está cada arquivo: 'media' (público, a Meta busca por link) ou 'inbound' (privado, o que os contatos enviam; só a rota autenticada da caixa de entrada lê).
-- Linhas antigas ficam em 'media', onde já estão.
ALTER TABLE media_objects ADD COLUMN bucket TEXT NOT NULL DEFAULT 'media' CHECK (bucket IN ('media', 'inbound'));
