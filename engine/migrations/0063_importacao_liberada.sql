-- Importar CSV pode ser desligado por espaço (no original ele só é liberado a pedido). Aqui nasce liberado.
ALTER TABLE workspaces ADD COLUMN import_enabled INTEGER NOT NULL DEFAULT 1 CHECK (import_enabled IN (0,1));
