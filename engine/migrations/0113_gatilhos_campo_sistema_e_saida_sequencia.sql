-- Regras: eventos 'campo do sistema alterado' (nome, e-mail, telefone...) e 'inscrição em sequência cancelada'.
-- Mesmo mecanismo dos demais eventos: gatilhos de banco gravam em rule_events e o motor consome.
CREATE TRIGGER rule_system_field_first_name AFTER UPDATE OF first_name ON contacts WHEN OLD.first_name IS NOT NEW.first_name AND NEW.status<>'deleted'
AND NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.id AND type='system_fields') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type,resource_id,value) VALUES(NEW.workspace_id,NEW.id,'system_field_changed','first_name',json_quote(NEW.first_name));
END;
CREATE TRIGGER rule_system_field_last_name AFTER UPDATE OF last_name ON contacts WHEN OLD.last_name IS NOT NEW.last_name AND NEW.status<>'deleted'
AND NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.id AND type='system_fields') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type,resource_id,value) VALUES(NEW.workspace_id,NEW.id,'system_field_changed','last_name',json_quote(NEW.last_name));
END;
CREATE TRIGGER rule_system_field_email AFTER UPDATE OF email ON contacts WHEN OLD.email IS NOT NEW.email AND NEW.status<>'deleted'
AND NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.id AND type='system_fields') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type,resource_id,value) VALUES(NEW.workspace_id,NEW.id,'system_field_changed','email',json_quote(NEW.email));
END;
CREATE TRIGGER rule_system_field_phone AFTER UPDATE OF phone ON contacts WHEN OLD.phone IS NOT NEW.phone AND NEW.status<>'deleted'
AND NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.id AND type='system_fields') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type,resource_id,value) VALUES(NEW.workspace_id,NEW.id,'system_field_changed','phone',json_quote(NEW.phone));
END;
CREATE TRIGGER rule_system_field_gender AFTER UPDATE OF gender ON contacts WHEN OLD.gender IS NOT NEW.gender AND NEW.status<>'deleted'
AND NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.id AND type='system_fields') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type,resource_id,value) VALUES(NEW.workspace_id,NEW.id,'system_field_changed','gender',json_quote(NEW.gender));
END;
CREATE TRIGGER rule_system_field_locale AFTER UPDATE OF locale ON contacts WHEN OLD.locale IS NOT NEW.locale AND NEW.status<>'deleted'
AND NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.id AND type='system_fields') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type,resource_id,value) VALUES(NEW.workspace_id,NEW.id,'system_field_changed','locale',json_quote(NEW.locale));
END;
CREATE TRIGGER rule_system_field_timezone AFTER UPDATE OF timezone ON contacts WHEN OLD.timezone IS NOT NEW.timezone AND NEW.status<>'deleted'
AND NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=NEW.workspace_id AND contact_id=NEW.id AND type='system_fields') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type,resource_id,value) VALUES(NEW.workspace_id,NEW.id,'system_field_changed','timezone',json_quote(NEW.timezone));
END;
CREATE TRIGGER rule_sequence_left AFTER DELETE ON sequence_subscriptions
WHEN EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) AND EXISTS(SELECT 1 FROM contacts WHERE id=OLD.contact_id)
AND EXISTS(SELECT 1 FROM sequences WHERE workspace_id=OLD.workspace_id AND id=OLD.sequence_id)
AND NOT EXISTS(SELECT 1 FROM rule_event_suppressions WHERE workspace_id=OLD.workspace_id AND contact_id=OLD.contact_id AND type='sequences') BEGIN
  INSERT INTO rule_events(workspace_id,contact_id,type,resource_id) VALUES(OLD.workspace_id,OLD.contact_id,'sequence_left',OLD.sequence_id);
END;
