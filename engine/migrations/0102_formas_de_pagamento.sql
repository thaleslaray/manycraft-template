-- Formas de pagamento da assinatura: cartão (Stripe) ou PayPal. Só uma vinculada por vez: PayPal fica bloqueado enquanto há cartão (e vice-versa).
CREATE TABLE payment_methods (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('card','paypal')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, kind)
);
CREATE TRIGGER payment_method_single BEFORE INSERT ON payment_methods
WHEN EXISTS (SELECT 1 FROM payment_methods WHERE workspace_id = NEW.workspace_id AND kind <> NEW.kind)
BEGIN SELECT RAISE(ABORT, 'payment_method_linked'); END;
