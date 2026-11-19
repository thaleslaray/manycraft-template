-- Permissões por automação: com a trava ligada, quais ações ficam só para dono e administrador (NULL = todas, como antes).
ALTER TABLE automations ADD COLUMN locked_actions TEXT CHECK (locked_actions IS NULL OR json_valid(locked_actions));
