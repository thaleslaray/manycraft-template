-- As confirmações são entradas do Básico; não criam palavras-chave de plano.
CREATE UNIQUE INDEX triggers_system_connection_kind
ON triggers(workspace_id,channel_id,json_extract(config,'$.system_kind'))
WHERE kind='external_trigger' AND json_extract(config,'$.system_kind') IN ('system_opt_in','system_opt_out')
AND channel_id IS NOT NULL AND audience='direct';

-- A origem é congelada no planejamento. Só a confirmação de saída pode responder ao descadastro.
ALTER TABLE flow_runs ADD COLUMN system_confirmation TEXT
CHECK (system_confirmation IS NULL OR system_confirmation IN ('system_opt_in','system_opt_out'));
