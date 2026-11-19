-- Link de compartilhamento protegido: a cópia salva por outra conta chega travada (só dono e administrador de lá editam).
ALTER TABLE automation_shares ADD COLUMN protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0,1));
