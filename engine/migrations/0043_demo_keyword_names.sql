-- Corrige somente os nomes originais das regras conhecidas da demonstração.
-- Nomes personalizados e registros de outros workspaces permanecem intactos.
UPDATE triggers SET name = 'Telegram: pedido do link'
WHERE id = 'w2-telegram-quero'
  AND workspace_id = 'demo-workspace'
  AND name = 'Pedido do link';

UPDATE triggers SET name = 'Instagram: pedido do link'
WHERE id = 'w13-instagram-quero'
  AND workspace_id = 'demo-workspace'
  AND name = 'Pedido do link';
