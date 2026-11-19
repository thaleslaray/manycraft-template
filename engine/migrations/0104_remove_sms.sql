-- O canal SMS (Twilio) saiu do produto: a marca de bloqueio pelo provedor de SMS não é mais usada.
ALTER TABLE contact_channels DROP COLUMN sms_provider_blocked_at;
