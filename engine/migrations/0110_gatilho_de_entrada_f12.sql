-- Ficha 12: o primeiro gatilho que dispara para um contato NOVO vira a origem de entrada dele ('trigger:<id>').
-- Fica no banco porque todas as famílias de gatilho (palavra-chave, comentário, story, link de referência,
-- grupo, externo) registram o disparo em trigger_firings; um ponto só cobre todas.
-- "Novo" = sem disparo anterior e criado até 10 minutos antes do disparo. A origem só é trocada quando ainda é
-- vazia ou o nome do canal que o criou; api, importação, Hotmart e anúncio continuam como estão.
CREATE TRIGGER trigger_firings_entry_source AFTER INSERT ON trigger_firings
WHEN NOT EXISTS (SELECT 1 FROM trigger_firings f WHERE f.workspace_id = NEW.workspace_id AND f.contact_id = NEW.contact_id AND f.id <> NEW.id)
BEGIN
  UPDATE contacts SET optin_source = 'trigger:' || NEW.trigger_id
  WHERE workspace_id = NEW.workspace_id AND id = NEW.contact_id
    AND created_at >= NEW.fired_at - 600000
    AND (optin_source IS NULL OR optin_source IN ('telegram','instagram','messenger','whatsapp','tiktok','email','comment'));
END;
