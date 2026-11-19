-- Saíram do produto: bloqueio por linha de crédito da Meta, pausa pelo agente de IA da Meta e os gatilhos de novo seguidor,
-- loja do Facebook e Ads JSON. Os marcadores guardados na conexão somem e os gatilhos que existiam ficam desativados.
UPDATE channels SET settings = json_remove(settings, '$.creditLineBlocked', '$.automationsPausedBy')
  WHERE json_valid(settings) AND (json_type(settings, '$.creditLineBlocked') IS NOT NULL OR json_type(settings, '$.automationsPausedBy') IS NOT NULL);
UPDATE triggers SET status = 'disabled' WHERE widget_type IN ('ig_follow', 'facebook_shops', 'ads_json') AND status <> 'disabled';
