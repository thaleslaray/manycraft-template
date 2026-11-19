-- Ajustes das máquinas de estado da 0125 (revisão).

-- E-mail da plataforma arquivado: o id é fixo (email-channel-<conta>) e a gravação de e-mail achava a linha arquivada sem recriá-la; arquivar
-- agora é recusado (archiveConnection). As linhas já arquivadas voltam como desativadas pela equipe (reativar é pelo botão da conexão), com o
-- external_id original de volta, só quando nenhuma outra conexão de e-mail ocupou esse endereço. As credenciais apagadas no arquivamento são
-- seladas de novo na próxima gravação de e-mail (emailConnection → configureCredentials).
UPDATE channels SET archived_at=NULL, status_detail='Desativada pela equipe. Reative quando quiser.',
    external_id=substr(external_id, length('archived:' || id || ':') + 1)
  WHERE type='email' AND provider='cloudflare_email' AND substr(id, 1, 14)='email-channel-' AND archived_at IS NOT NULL
    AND substr(external_id, 1, length('archived:' || id || ':'))='archived:' || id || ':'
    AND NOT EXISTS (SELECT 1 FROM channels o WHERE o.type='email' AND o.id<>channels.id
      AND o.external_id=substr(channels.external_id, length('archived:' || channels.id || ':') + 1));

-- Inscrição cujo passo perdeu a execução: segue para o próximo passo publicado com a espera dele contada de agora (como o `skip` de
-- flow/sequences.ts e o fim de passo cancelado), em vez de ficar agendada no passado e disparar o passo seguinte na hora. Sem próximo
-- passo, termina (next_at NULL), como o `skip` faz. Horas em milissegundos.
DROP TRIGGER sequence_subscriptions_run_gone;
CREATE TRIGGER sequence_subscriptions_run_gone AFTER UPDATE OF pending_run_id ON sequence_subscriptions
WHEN NEW.pending_run_id IS NULL AND OLD.pending_run_id IS NOT NULL AND NEW.pending_step_id IS NOT NULL
BEGIN
  UPDATE sequence_subscriptions SET pending_step_id=NULL,
    next_step=coalesce((SELECT t.position FROM sequence_steps t WHERE t.workspace_id=NEW.workspace_id AND t.sequence_id=NEW.sequence_id AND t.status='live'
      AND t.position>coalesce((SELECT p.position FROM sequence_steps p WHERE p.workspace_id=NEW.workspace_id AND p.sequence_id=NEW.sequence_id AND p.id=NEW.pending_step_id), NEW.next_step)
      ORDER BY t.position LIMIT 1), NEW.next_step+1),
    next_at=(SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) + t.delay_seconds * 1000 FROM sequence_steps t
      WHERE t.workspace_id=NEW.workspace_id AND t.sequence_id=NEW.sequence_id AND t.status='live'
      AND t.position>coalesce((SELECT p.position FROM sequence_steps p WHERE p.workspace_id=NEW.workspace_id AND p.sequence_id=NEW.sequence_id AND p.id=NEW.pending_step_id), NEW.next_step)
      ORDER BY t.position LIMIT 1)
  WHERE sequence_id=NEW.sequence_id AND contact_id=NEW.contact_id;
END;

-- Linha antiga com status='error' (a chave da equipe só tem ligada/desligada hoje): o painel não tinha como consertá-la. Volta a ligada
-- com a saúde 'error' (o "Atualizar conexão" e o "Trocar credencial" consertam). O gatilho channels_state_follows_status (0012) copia o
-- status para a saúde; a volta a 'error' passa por 'connecting' para o aviso "A conexão parou" (notice_connection_down, só na saída de
-- 'connected') não disparar: a conexão já estava com erro.
CREATE TABLE _m0126_status_error AS SELECT id FROM channels WHERE status='error';
UPDATE channels SET status='connected' WHERE id IN (SELECT id FROM _m0126_status_error);
UPDATE channels SET connection_state='connecting' WHERE id IN (SELECT id FROM _m0126_status_error);
UPDATE channels SET connection_state='error' WHERE id IN (SELECT id FROM _m0126_status_error);
DROP TABLE _m0126_status_error;

-- Linha criada já desligada com outra saúde: a correção para 'disconnected' saía de 'connected' e disparava o aviso "A conexão parou".
-- Passar por 'connecting' (como a 0125 fez nos dados) não dá: channels_disabled_state recusa qualquer saúde diferente de desligada numa
-- conexão desligada. Quem cala o aviso é o próprio aviso: mudança de saúde com a conexão desligada antes e depois não é queda (a conexão já
-- estava desligada). Desativar pela equipe (ligada → desligada) segue avisando como antes.
DROP TRIGGER notice_connection_down;
CREATE TRIGGER notice_connection_down AFTER UPDATE OF connection_state ON channels
WHEN NEW.connection_state IN ('error','disconnected','restricted') AND OLD.connection_state='connected' AND NEW.archived_at IS NULL
  AND NOT (OLD.status='disconnected' AND NEW.status='disconnected') BEGIN
  INSERT INTO workspace_notices (workspace_id,kind,message)
    SELECT NEW.workspace_id,'connection','A conexão ' || coalesce(NEW.display_name,NEW.type) || ' parou: ' || coalesce(NEW.status_detail,'verifique em Configurações › Canais.')
    WHERE coalesce(json_extract(NEW.settings,'$.disconnection.notify'),1)=1;
  UPDATE broadcasts SET paused_at=CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE workspace_id=NEW.workspace_id AND channel_id=NEW.id AND status IN ('scheduled','sending') AND paused_at IS NULL
    AND coalesce(json_extract(NEW.settings,'$.disconnection.pause_broadcasts'),0)=1;
END;
