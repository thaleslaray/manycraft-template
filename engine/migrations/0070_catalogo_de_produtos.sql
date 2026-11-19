-- Catálogo de produtos do espaço: a equipe envia no chat nome, preço e link de pagamento (Payment Link do Stripe, PayPal ou outro checkout).
CREATE TABLE products (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description TEXT CHECK (description IS NULL OR length(description) <= 500),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'BRL' CHECK (currency IN ('BRL','USD','EUR')),
  payment_url TEXT NOT NULL CHECK (payment_url LIKE 'https://%'),
  image_url TEXT CHECK (image_url IS NULL OR image_url LIKE 'https://%'),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX products_workspace ON products (workspace_id, archived, name);
