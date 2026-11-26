-- LOCAL ONLY. Pessoas/negócios inventados. Não cria senha ou credencial real.
INSERT OR IGNORE INTO "user"(id,name,email,emailVerified,createdAt,updatedAt)
VALUES ('demo-user','Lia Exemplo','lia@example.test',1,datetime('now'),datetime('now'));
INSERT OR IGNORE INTO workspaces(id,name,timezone) VALUES ('demo-workspace','Oficina Horizonte Inventada','America/Sao_Paulo');
INSERT OR IGNORE INTO workspace_members(id,workspace_id,user_id,role) VALUES ('demo-owner','demo-workspace','demo-user','owner');
INSERT OR IGNORE INTO channels(id,workspace_id,type,external_id,status,display_name) VALUES ('demo-telegram','demo-workspace','telegram','bot-inventado','disconnected','Atendimento de demonstração');
INSERT OR IGNORE INTO contacts(id,workspace_id,first_name,last_name,subscribed_at) VALUES ('demo-contact-1','demo-workspace','Nara','Exemplo',CAST(unixepoch('subsec')*1000 AS INTEGER));
INSERT OR IGNORE INTO contacts(id,workspace_id,first_name,last_name,subscribed_at) VALUES ('demo-contact-2','demo-workspace','Davi','Demonstração',CAST(unixepoch('subsec')*1000 AS INTEGER));
INSERT OR IGNORE INTO tags(id,workspace_id,name) VALUES ('demo-tag','demo-workspace','Interesse em oficina');
INSERT OR IGNORE INTO contact_tags(workspace_id,contact_id,tag_id) VALUES ('demo-workspace','demo-contact-1','demo-tag');
INSERT OR IGNORE INTO automations(id,workspace_id,name,draft_graph) VALUES ('demo-automation','demo-workspace','Boas-vindas à oficina','{"nodes":[{"id":"t","type":"trigger","position":{"x":0,"y":0},"config":{}},{"id":"m","type":"message","position":{"x":200,"y":0},"config":{"blocks":[{"kind":"text","text":"Olá! Vamos encontrar uma oficina para você?"}]}}],"edges":[{"from":"t","port":"next","to":"m"}]}');

-- Senha de teste da Lia (só no banco local): demo-d606be70. Só vale com PASSWORD_LOGIN=1 no engine/.dev.vars (a senha fica
-- desligada no local); o botão "Entrar (teste)" do painel entra sem ela, por POST /api/dev/sign-in.
INSERT OR REPLACE INTO account (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES ('demo-user-credential','demo-user','credential','demo-user','8fd5ebc8fa0853eb0d30a51c3cdeae1f:3cbd8ef5d6428f35c220d003fd6fb72df405d716d34b7418b943da65c79d8d6248f0f4662f3a851943b42c6b61ffa47d6c29f58608982a7fbded098fe4950df0',datetime('now'),datetime('now'));
