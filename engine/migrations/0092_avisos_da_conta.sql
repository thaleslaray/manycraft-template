-- Avisos da conta (sininho do painel e e-mail opcional): limite de contatos do plano, conexão que caiu e restrição da conta.
CREATE TABLE workspace_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('plan_limit','connection','restriction','wallet')),
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  read_at INTEGER,
  emailed_at INTEGER
);
CREATE INDEX workspace_notices_unread ON workspace_notices(workspace_id, read_at, id);
-- Preferências de e-mail por tipo de aviso; restrição da conta (banimento) definida pela operação da plataforma.
ALTER TABLE workspaces ADD COLUMN notice_prefs TEXT NOT NULL DEFAULT '{"plan_limit":true,"connection":true,"restriction":true,"wallet":true}' CHECK (json_valid(notice_prefs));
ALTER TABLE workspaces ADD COLUMN restricted_reason TEXT;

CREATE TRIGGER notice_plan_alert AFTER INSERT ON plan_alerts BEGIN
  INSERT INTO workspace_notices (workspace_id,kind,message) VALUES (NEW.workspace_id,'plan_limit',
    CASE WHEN NEW.threshold>=100 THEN 'O limite de contatos ativos do plano foi atingido: novos contatos não recebem mensagens até o próximo ciclo.'
    ELSE 'Você usou ' || NEW.threshold || '% dos contatos ativos do plano neste ciclo.' END);
END;
-- Condições de desconexão: ao cair, avisa e (se a conexão pedir) pausa as transmissões agendadas ou em envio dela.
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
