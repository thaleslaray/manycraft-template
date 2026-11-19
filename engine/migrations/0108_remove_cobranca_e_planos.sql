-- Sistema de uso interno, 100% liberado: saem planos, limites por plano, cobrança, carteira, formas de pagamento e avisos de limite/saldo.
-- Limites por plano no banco (automações ativas, palavras-chave) e o aviso de 70/90/100% dos contatos ativos.
DROP TRIGGER plan_active_automations_insert;
DROP TRIGGER plan_active_automations_update;
DROP TRIGGER plan_keywords_insert;
DROP TRIGGER plan_keywords_update;
DROP TRIGGER notice_plan_alert;
-- Contagem mensal de contatos ativos, alertas e bloqueios; formas de pagamento (PayPal/cartão); carteira e assinatura.
DROP TABLE plan_alerts;
DROP TABLE plan_contact_blocks;
DROP TABLE active_contact_usage;
DROP TABLE payment_methods;
DROP TABLE wallet_transactions;
DROP TABLE wallets;
DROP TABLE subscriptions;
-- Colunas só de cobrança.
ALTER TABLE workspaces DROP COLUMN overage_limit;
ALTER TABLE workspace_members DROP COLUMN can_manage_billing;
ALTER TABLE email_settings DROP COLUMN balance;
-- plan_limits perde preços e tetos. A tabela em si fica: workspaces.plan a referencia por chave estrangeira e o SQLite não
-- remove coluna com chave estrangeira; recriar workspaces (referenciada por quase todas as tabelas, com ON DELETE CASCADE) é arriscado
-- demais para sair só com isso. Fica a coluna inerte workspaces.plan (sempre 'free') e as cinco linhas de plan_limits, que nada lê.
ALTER TABLE plan_limits DROP COLUMN active_contacts;
ALTER TABLE plan_limits DROP COLUMN inbox_seats;
ALTER TABLE plan_limits DROP COLUMN max_channels;
ALTER TABLE plan_limits DROP COLUMN ai_included;
ALTER TABLE plan_limits DROP COLUMN advanced_automations;
ALTER TABLE plan_limits DROP COLUMN price_month_cents;
ALTER TABLE plan_limits DROP COLUMN price_year_month_cents;
ALTER TABLE plan_limits DROP COLUMN max_active_automations;
ALTER TABLE plan_limits DROP COLUMN max_keywords;
UPDATE workspaces SET plan = 'free';

-- Avisos: saem os tipos 'plan_limit' e 'wallet' (tabela, preferências e padrão da coluna).
-- Os gatilhos que escrevem em workspace_notices caem antes de recriar a tabela e voltam iguais depois.
DROP TRIGGER notice_connection_down;
DROP TRIGGER notice_restriction;
DELETE FROM workspace_notices WHERE kind IN ('plan_limit','wallet');
CREATE TABLE workspace_notices_novo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('connection','restriction')),
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  read_at INTEGER,
  emailed_at INTEGER
);
INSERT INTO workspace_notices_novo (id,workspace_id,kind,message,created_at,read_at,emailed_at)
  SELECT id,workspace_id,kind,message,created_at,read_at,emailed_at FROM workspace_notices;
DROP TABLE workspace_notices;
ALTER TABLE workspace_notices_novo RENAME TO workspace_notices;
CREATE INDEX workspace_notices_unread ON workspace_notices(workspace_id, read_at, id);
CREATE TRIGGER notice_connection_down AFTER UPDATE OF connection_state ON channels
WHEN NEW.connection_state IN ('error','disconnected','restricted') AND OLD.connection_state='connected' AND NEW.archived_at IS NULL BEGIN
  INSERT INTO workspace_notices (workspace_id,kind,message)
    SELECT NEW.workspace_id,'connection','A conexão ' || coalesce(NEW.display_name,NEW.type) || ' parou: ' || coalesce(NEW.status_detail,'verifique em Configurações › Canais.')
    WHERE coalesce(json_extract(NEW.settings,'$.disconnection.notify'),1)=1;
  UPDATE broadcasts SET paused_at=CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE workspace_id=NEW.workspace_id AND channel_id=NEW.id AND status IN ('scheduled','sending') AND paused_at IS NULL
    AND coalesce(json_extract(NEW.settings,'$.disconnection.pause_broadcasts'),0)=1;
END;
CREATE TRIGGER notice_restriction AFTER UPDATE OF restricted_reason ON workspaces WHEN NEW.restricted_reason IS NOT NULL AND OLD.restricted_reason IS NOT NEW.restricted_reason BEGIN
  INSERT INTO workspace_notices (workspace_id,kind,message) VALUES (NEW.id,'restriction','Sua conta foi restringida: ' || NEW.restricted_reason);
END;
ALTER TABLE workspaces ADD COLUMN notice_prefs_tmp TEXT;
UPDATE workspaces SET notice_prefs_tmp = json_remove(notice_prefs, '$.plan_limit', '$.wallet');
ALTER TABLE workspaces DROP COLUMN notice_prefs;
ALTER TABLE workspaces ADD COLUMN notice_prefs TEXT NOT NULL DEFAULT '{"connection":true,"restriction":true}' CHECK (json_valid(notice_prefs));
UPDATE workspaces SET notice_prefs = notice_prefs_tmp;
ALTER TABLE workspaces DROP COLUMN notice_prefs_tmp;
