-- Quem entra por um gatilho de widget (comentário, story, link de referência...) ganha uma tag com o nome do gatilho
-- em minúsculas e com _ no lugar de espaço. Vale para todo caminho de disparo porque mora no registro do disparo.
CREATE TRIGGER trigger_firings_widget_tag AFTER INSERT ON trigger_firings
WHEN EXISTS (SELECT 1 FROM triggers WHERE workspace_id = NEW.workspace_id AND id = NEW.trigger_id AND kind = 'widget' AND trim(name) <> '')
BEGIN
  INSERT INTO tags (id, workspace_id, name)
    SELECT 'widget-' || lower(hex(randomblob(8))), NEW.workspace_id, replace(lower(trim(name)), ' ', '_')
    FROM triggers WHERE workspace_id = NEW.workspace_id AND id = NEW.trigger_id
  ON CONFLICT (workspace_id, name) DO NOTHING;
  INSERT INTO contact_tags (workspace_id, contact_id, tag_id)
    SELECT NEW.workspace_id, NEW.contact_id, tg.id FROM triggers t
    JOIN tags tg ON tg.workspace_id = t.workspace_id AND tg.name = replace(lower(trim(t.name)), ' ', '_')
    WHERE t.workspace_id = NEW.workspace_id AND t.id = NEW.trigger_id
  ON CONFLICT (contact_id, tag_id) DO NOTHING;
END;
