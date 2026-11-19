-- Modo agência: perfil da agência da pessoa (nome e site) e painel com os espaços de clientes que ela administra.
CREATE TABLE agency_profiles (
  user_id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  website TEXT,
  created_at INTEGER NOT NULL
);
