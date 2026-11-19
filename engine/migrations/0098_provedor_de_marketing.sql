-- E-mail de marketing real: chave de um provedor que aceita marketing (Resend), cifrada; sem ela, marketing fica em simulação fora do desenvolvimento.
ALTER TABLE email_settings ADD COLUMN marketing_key_ciphertext TEXT;
ALTER TABLE email_settings ADD COLUMN marketing_key_iv TEXT;
ALTER TABLE email_settings ADD COLUMN marketing_key_version INTEGER;
