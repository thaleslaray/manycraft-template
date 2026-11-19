-- A automação iniciada pela equipe no inbox (execução 'inbox-...') entra no histórico com a origem 'manual',
-- e não mais como 'another_flow', que é o passo "iniciar outra automação". Os registros antigos ficam como estão.
DROP TRIGGER timeline_run;
CREATE TRIGGER timeline_run AFTER INSERT ON flow_runs
WHEN NEW.channel_id IS NOT NULL BEGIN
  INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at)
  SELECT 'event-run-' || NEW.id || '-' || timeline.id,NEW.workspace_id,timeline.id,'out','human',
    json_object('sender','system','text','','status','sent','event',json_object('kind','trigger','automation_id',(SELECT automation_id FROM automation_versions WHERE workspace_id=NEW.workspace_id AND id=NEW.automation_version_id),'automation_name',(SELECT a.name FROM automation_versions av JOIN automations a ON a.workspace_id=av.workspace_id AND a.id=av.automation_id WHERE av.workspace_id=NEW.workspace_id AND av.id=NEW.automation_version_id),'trigger_kind',CASE WHEN NEW.id LIKE 'inbox-%' THEN 'manual' ELSE coalesce((SELECT kind FROM triggers WHERE workspace_id=NEW.workspace_id AND id=NEW.trigger_id),'another_flow') END)),NEW.created_at
  FROM (SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id WHERE v.workspace_id=NEW.workspace_id AND cc.contact_id=NEW.contact_id AND cc.channel_id=NEW.channel_id) timeline ;
END;
