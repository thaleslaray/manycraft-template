-- opt_in_status do gatilho: quem entra por um gatilho "não enviar" (do_not_send) conversa normalmente, mas fica fora das transmissões
-- até se inscrever de fato (palavra de inscrição ou ação de inscrição).
ALTER TABLE contact_channels ADD COLUMN broadcast_opt_in INTEGER NOT NULL DEFAULT 1 CHECK (broadcast_opt_in IN (0,1));
