-- Hotmart, hottok: ele só confere a origem do webhook e o painel nunca o mostra de volta, então fica guardado só o SHA-256
-- (secret_hash, como o webhook_secret_hash dos canais). As linhas de antes guardam o valor em claro em secret; o motor troca
-- pelo hash no primeiro webhook, ao gravar outro hottok e no cron diário (src/hotmart.ts). Depois disso secret fica sempre NULL.
ALTER TABLE integration_hooks ADD COLUMN secret_hash TEXT CHECK (secret_hash IS NULL OR length(secret_hash) = 64);

-- Hotmart, reentrega: a Hotmart reenvia eventos e cada um traz o campo "id", o código único do evento (contrato 2.0.0).
-- A chave é por espaço, para um espaço nunca marcar como visto o evento de outro. O cron diário apaga as marcas com mais de
-- 60 dias, o prazo em que a Hotmart guarda o histórico de eventos (e pode reenviá-los).
CREATE TABLE hotmart_events (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, event_id)
);
CREATE INDEX hotmart_events_received ON hotmart_events(received_at);
