-- Automação travada pelo dono ou administrador: os demais papéis só leem (editar, publicar, mover, excluir e gatilhos ficam bloqueados).
ALTER TABLE automations ADD COLUMN locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1));
