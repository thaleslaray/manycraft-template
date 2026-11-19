-- O código do link de referência identifica o gatilho dentro do canal (wa.me, m.me e ig.me devolvem só ele): não pode repetir.
-- Duplicar automação copiava o código; quem já repetiu ganha código novo (8 caracteres sem 0, 1, i, l, o), o gatilho mais antigo fica com o dele.
UPDATE triggers SET config = json_set(config, '$.code', replace(replace(lower(hex(randomblob(4))), '0', 'g'), '1', 'h'))
WHERE kind = 'widget' AND widget_type = 'messenger_ref_url' AND channel_id IS NOT NULL AND json_extract(config, '$.code') IS NOT NULL
  AND id <> (SELECT o.id FROM triggers o WHERE o.kind = 'widget' AND o.widget_type = 'messenger_ref_url' AND o.channel_id = triggers.channel_id
    AND json_extract(o.config, '$.code') = json_extract(triggers.config, '$.code') ORDER BY o.created_at, o.id LIMIT 1);

CREATE UNIQUE INDEX triggers_codigo_de_referencia ON triggers(channel_id, json_extract(config, '$.code'))
WHERE kind = 'widget' AND widget_type = 'messenger_ref_url' AND json_extract(config, '$.code') IS NOT NULL;
