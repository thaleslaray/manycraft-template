-- Convites já emitidos também respeitam a janela de 24 horas.
UPDATE invites SET expires_at = MIN(expires_at, created_at + 86400000);
