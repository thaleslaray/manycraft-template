-- Todo gatilho widget (comentário, story, link de referência...) pertence a uma conexão: o canal dele é o da conexão.
-- Widget antigo sem conexão ganha uma conexão do canal que o tipo dele usa, escolhida assim: a conectada primeiro, depois a mais antiga não arquivada.
--   messenger_ref_url, messenger_code, facebook_shops, ads_json, ads            -> messenger
--   ctwa_trigger                                                               -> whatsapp
--   tiktok_ads_ctx                                                             -> tiktok
--   feed_comment, feed_comment_trigger e os instagram_*                        -> instagram
-- Sem conexão compatível o widget NÃO é apagado (perderia disparos e impressões): vira rascunho sem conexão, que não dispara
-- e pode ser ligado a uma conexão depois. Só rascunho pode ficar sem conexão (as regras do banco logo abaixo).
UPDATE triggers SET channel_id = (
  SELECT c.id FROM channels c WHERE c.workspace_id = triggers.workspace_id AND c.archived_at IS NULL
    AND c.type = CASE
      WHEN triggers.widget_type IN ('messenger_ref_url','messenger_code','facebook_shops','ads_json','ads') THEN 'messenger'
      WHEN triggers.widget_type = 'ctwa_trigger' THEN 'whatsapp'
      WHEN triggers.widget_type = 'tiktok_ads_ctx' THEN 'tiktok'
      ELSE 'instagram' END
  ORDER BY (c.status = 'connected') DESC, c.created_at, c.id LIMIT 1)
WHERE kind = 'widget' AND channel_id IS NULL;
UPDATE triggers SET status = 'draft' WHERE kind = 'widget' AND channel_id IS NULL AND status <> 'draft';

-- A tabela não é recriada (os filhos dela apagariam em cascata): a regra vai em dois gatilhos do banco.
CREATE TRIGGER triggers_widget_exige_conexao_insert BEFORE INSERT ON triggers
WHEN NEW.kind = 'widget' AND NEW.channel_id IS NULL AND NEW.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'Todo gatilho de widget ligado exige uma conexão.'); END;
CREATE TRIGGER triggers_widget_exige_conexao_update BEFORE UPDATE OF kind, channel_id, status ON triggers
WHEN NEW.kind = 'widget' AND NEW.channel_id IS NULL AND NEW.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'Todo gatilho de widget ligado exige uma conexão.'); END;
