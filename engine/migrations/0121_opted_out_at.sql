-- Marca explícita de "pediu para sair" na conexão: gravada por todo caminho que retira o opt-in a pedido da pessoa ou do operador, limpa quando o opt-in volta.
-- A resposta privada a comentário lê só esta marca (antes: opted_in=0 com primeira mensagem, que não reconhecia quem nasceu de comentário e saiu por ação de fluxo).
ALTER TABLE contact_channels ADD COLUMN opted_out_at INTEGER;
-- Linhas antigas que o critério anterior reconhecia.
UPDATE contact_channels SET opted_out_at=coalesce(consent_changed_at,CAST(unixepoch('subsec')*1000 AS INTEGER)) WHERE opted_in=0 AND first_inbound_id IS NOT NULL;
