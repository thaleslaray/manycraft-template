-- Preferências de exibição do espaço (Configurações > Geral):
-- show_only_subscribed: a lista de contatos esconde descadastrados até a pessoa pedir para ver (padrão ligado, como no original).
-- hide_keywords_tab / hide_rules_tab: abas de Automação que o espaço não usa somem da navegação.
ALTER TABLE workspaces ADD COLUMN show_only_subscribed INTEGER NOT NULL DEFAULT 1 CHECK (show_only_subscribed IN (0,1));
ALTER TABLE workspaces ADD COLUMN hide_keywords_tab INTEGER NOT NULL DEFAULT 0 CHECK (hide_keywords_tab IN (0,1));
ALTER TABLE workspaces ADD COLUMN hide_rules_tab INTEGER NOT NULL DEFAULT 0 CHECK (hide_rules_tab IN (0,1));
