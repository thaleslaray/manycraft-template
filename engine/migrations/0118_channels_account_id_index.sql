-- Auditoria D3: a rota compartilhada da Meta busca as conexões de uma conta por json_extract(settings,'$.accountId'); sem índice cada id percorria a tabela inteira.
CREATE INDEX IF NOT EXISTS idx_channels_account_id ON channels (type, json_extract(settings, '$.accountId')) WHERE status = 'connected';
