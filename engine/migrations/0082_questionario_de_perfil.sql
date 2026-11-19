-- Questionário de perfil no cadastro: o que o espaço faz e o que quer automatizar primeiro (sugere o caso de uso empacotado).
ALTER TABLE workspaces ADD COLUMN profile_answers TEXT CHECK (profile_answers IS NULL OR json_valid(profile_answers));
