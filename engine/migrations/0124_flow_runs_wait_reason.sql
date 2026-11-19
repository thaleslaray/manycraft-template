-- Máquina de estados das execuções (engine/src/flow/run-state.ts): waiting_delay juntava esperas diferentes. O motivo fica explícito.
-- delay: passo Espera; story_delay: pausa do gatilho de story; human_pause: atendimento humano; safety_pause: trava de 30 passos seguidos
-- (sem retomada; error segue 'consecutive_block_limit'); call: esperando a automação chamada; connection: conexão restrita ou fora do ar.
ALTER TABLE flow_runs ADD COLUMN wait_reason TEXT
  CHECK (wait_reason IS NULL OR wait_reason IN ('delay','story_delay','human_pause','safety_pause','call','connection'));

-- Execuções paradas hoje: a trava se reconhece pelo erro, a espera da chamada por não ter hora; pausa humana e passo Espera não se
-- distinguem nos dados antigos e ficam como 'delay' (as duas acordam em wait_until).
UPDATE flow_runs SET wait_reason = CASE
    WHEN error = 'consecutive_block_limit' THEN 'safety_pause'
    WHEN wait_until IS NULL THEN 'call'
    WHEN story_context IS NOT NULL AND current_node_id IS NULL THEN 'story_delay'
    ELSE 'delay' END
  WHERE status = 'waiting_delay';

-- O motivo só vale em waiting_delay: qualquer escritor que leve a execução a outro status (cancelamentos em lote inclusive) o limpa.
CREATE TRIGGER flow_runs_wait_reason_clear AFTER UPDATE OF status ON flow_runs
WHEN NEW.status <> 'waiting_delay' AND NEW.wait_reason IS NOT NULL BEGIN
  UPDATE flow_runs SET wait_reason = NULL WHERE rowid = NEW.rowid;
END;

-- O evento "espera iniciada" da conversa vale só para o passo Espera, pelo motivo (antes: pelo tipo do passo atual, que a pausa humana
-- e a espera da conexão também podiam ter).
DROP TRIGGER timeline_delay;
CREATE TRIGGER timeline_delay AFTER UPDATE ON flow_runs
WHEN NEW.status='waiting_delay' AND NEW.wait_reason='delay' AND NEW.wait_until IS NOT NULL AND (OLD.status IS NOT NEW.status OR OLD.current_node_id IS NOT NEW.current_node_id) AND EXISTS (SELECT 1 FROM automation_versions av,json_each(av.graph,'$.nodes') n WHERE av.workspace_id=NEW.workspace_id AND av.id=NEW.automation_version_id AND json_extract(n.value,'$.id')=NEW.current_node_id AND json_extract(n.value,'$.type')='smart_delay') BEGIN
  INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at)
  SELECT 'event-' || lower(hex(randomblob(16))),NEW.workspace_id,timeline.id,'out','human',
    json_object('sender','system','text','','status','sent','event',json_object('kind','delay_started','automation_id',(SELECT automation_id FROM automation_versions WHERE workspace_id=NEW.workspace_id AND id=NEW.automation_version_id),'automation_name',(SELECT a.name FROM automation_versions av JOIN automations a ON a.workspace_id=av.workspace_id AND a.id=av.automation_id WHERE av.workspace_id=NEW.workspace_id AND av.id=NEW.automation_version_id),'ends_at',strftime('%Y-%m-%dT%H:%M:%fZ',NEW.wait_until/1000.0,'unixepoch'))),CAST(unixepoch('subsec')*1000 AS INTEGER)
  FROM (SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id WHERE v.workspace_id=NEW.workspace_id AND cc.contact_id=NEW.contact_id AND cc.channel_id=NEW.channel_id) timeline ;
END;

-- A retomada pela conexão procura só as execuções que esperam por ela.
CREATE INDEX flow_runs_connection_wait ON flow_runs (channel_id) WHERE status = 'waiting_delay' AND wait_reason = 'connection';
