-- O porquê da pausa dos envios de e-mail, para a tela dizer o motivo e o que fazer:
-- 'bounce' | 'unsubscribe' | 'complaint' (taxa acima do limite), 'provider' (o serviço suspendeu a conta) ou 'manual'.
ALTER TABLE email_settings ADD COLUMN pause_reason TEXT;
