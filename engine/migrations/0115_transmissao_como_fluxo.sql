-- O conteúdo de toda transmissão passa a viver num fluxo (grafo), no mesmo formato do editor de automação.
-- Transmissão comum: um passo só ('broadcast-message') com o texto, e o e-mail ou o modelo quando houver.
-- Cópia de automação: o fluxo é o próprio grafo copiado. Nada é apagado: content/template/email_content seguem como espelho.
ALTER TABLE broadcasts ADD COLUMN flow TEXT CHECK(flow IS NULL OR json_valid(flow));
UPDATE broadcasts SET flow = CASE WHEN copied_graph IS NOT NULL THEN copied_graph ELSE json_object(
  'nodes', json_array(json_object('id','broadcast-message','type','message','position',json_object('x',0,'y',0),
    'config', json_remove(json_object('blocks', json_array(json_object('kind','text','text',content)),
      'email', json(email_content), 'template', json(template)),
      CASE WHEN email_content IS NULL THEN '$.email' ELSE '$.__' END,
      CASE WHEN template IS NULL THEN '$.template' ELSE '$.__' END))),
  'edges', json_array()) END
WHERE flow IS NULL;
