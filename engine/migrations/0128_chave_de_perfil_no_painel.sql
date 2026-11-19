-- API total: a chave de perfil abre as rotas do painel (/api/*).
-- Escopo da chave: 'read' só aceita GET/HEAD; 'write' (padrão, inclusive para as chaves já existentes) aceita tudo que o papel permite.
ALTER TABLE user_api_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'write' CHECK (scope IN ('read','write'));
-- Rastro no log de atividade: por onde veio a alteração ('painel' ou 'api') e qual chave de perfil foi usada.
ALTER TABLE activity_log ADD COLUMN via TEXT NOT NULL DEFAULT 'painel';
ALTER TABLE activity_log ADD COLUMN api_key_id TEXT;
-- Nome da chave (obrigatório ao criar pelo painel); as chaves que já existem recebem 'Chave antiga'.
ALTER TABLE user_api_keys ADD COLUMN name TEXT NOT NULL DEFAULT 'Chave antiga';
