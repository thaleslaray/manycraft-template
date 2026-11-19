-- Idempotência dos eventos reais de envio do Cloudflare Email Service (cf.email.sending.message.*), entregues por Queues
-- com garantia "pelo menos uma vez". event_id é o payload.eventId do evento.
CREATE TABLE email_sending_events (
  event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE INDEX email_sending_events_received ON email_sending_events(received_at);
