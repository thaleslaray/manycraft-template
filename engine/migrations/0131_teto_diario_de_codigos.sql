-- Teto diário de códigos de login enviados por e-mail, no total (OTP_DAILY_LIMIT, padrão 100).
-- Uma linha por dia no fuso de São Paulo ('AAAA-MM-DD'); conta só o código que saiu de fato.
-- O limite por IP e por e-mail não segura quem varia os destinatários; este teto protege a cota do provedor.
CREATE TABLE login_code_daily (day TEXT PRIMARY KEY, total INTEGER NOT NULL DEFAULT 0);
