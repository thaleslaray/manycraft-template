-- Saúde da conta: o contato que parou de receber marketing (marcado e com o horário do último aviso, para um aviso atrasado não desfazer o mais novo)
-- e o estado que o provedor avisa sobre a conexão (qualidade, limite, alertas, restrições, revisão), cada parte com o horário do aviso em `at` (ms).
ALTER TABLE contact_channels ADD COLUMN marketing_blocked_at INTEGER;
ALTER TABLE contact_channels ADD COLUMN marketing_preference_at INTEGER;
ALTER TABLE channels ADD COLUMN provider_health TEXT NOT NULL DEFAULT '{"alerts":{}}' CHECK (json_valid(provider_health));
