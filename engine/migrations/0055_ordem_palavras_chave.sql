-- Palavras-chave de topo empatadas (ex.: várias com prioridade 0, gravadas pelo editor, modelos e duplicação) ganham posição única por workspace.
-- A ordem antiga é preservada: prioridade atual, depois a especificidade que o motor usava (is > starts_with > word_match > contains >
-- does_not_contain > resto; grupo vale o maior filho), mais condições primeiro, e por fim o gatilho mais antigo, o ID do gatilho e da palavra.
WITH ranked AS (
  SELECT k.id AS id, row_number() OVER (PARTITION BY k.workspace_id ORDER BY k.priority,
    CASE WHEN k.rule='group' THEN coalesce((SELECT max(CASE c.rule WHEN 'is' THEN 5 WHEN 'starts_with' THEN 4 WHEN 'word_match' THEN 3
      WHEN 'contains' THEN 2 WHEN 'does_not_contain' THEN 1 WHEN 'thumbs_up' THEN -1 ELSE 0 END) FROM keywords c WHERE c.parent_id=k.id),-1)
      ELSE CASE k.rule WHEN 'is' THEN 5 WHEN 'starts_with' THEN 4 WHEN 'word_match' THEN 3 WHEN 'contains' THEN 2
        WHEN 'does_not_contain' THEN 1 WHEN 'thumbs_up' THEN -1 ELSE 0 END END DESC,
    CASE WHEN k.rule='group' THEN (SELECT count(*) FROM keywords c WHERE c.parent_id=k.id) ELSE 1 END DESC,
    t.created_at, t.id, k.id) - 1 AS position
  FROM keywords k JOIN triggers t ON t.workspace_id=k.workspace_id AND t.id=k.trigger_id
  WHERE k.parent_id IS NULL)
UPDATE keywords SET priority=(SELECT position FROM ranked WHERE ranked.id=keywords.id)
WHERE id IN (SELECT id FROM ranked);
