# ManyCraft

Um sistema de automação de conversas para Instagram, WhatsApp e Telegram, feito para estudo. Você monta fluxos (a pessoa manda uma palavra, o sistema responde, pergunta, espera, aplica etiquetas), atende pelo painel de caixa de entrada, organiza contatos e faz transmissões.

> **Aviso importante.** Este é um projeto de estudo, independente. Não tem vínculo, parceria nem aprovação da ManyChat, da Meta (Instagram, WhatsApp, Facebook), do Telegram nem da Cloudflare. Todos os nomes pertencem a seus donos. O importador de fluxos lê o formato de compartilhamento da ManyChat, que é um formato de terceiro, não documentado oficialmente, e pode parar de funcionar a qualquer momento. Os dados de demonstração (pessoas, lojas, telefones) são inventados.

## Como pedir ao Claude Code para instalar

Abra esta pasta no Claude Code e diga algo como:

> Leia o README.md e instale o ManyCraft no meu computador para eu testar. Depois me ajude a publicar na minha conta da Cloudflare.

Os comandos abaixo são o que ele vai executar. Quando um passo diz "confira", é porque não foi possível garantir o comando exato: peça ao Claude Code para conferir na documentação atual da Cloudflare ou da Meta.

## O que ele faz

- Responde mensagens automaticamente (fluxos com mensagens, botões, perguntas, esperas, condições e ações).
- Reage a palavras-chave, a comentários do Instagram, a respostas de Stories e a links de referência.
- Caixa de entrada para atendimento humano, com equipe e papéis.
- Contatos, etiquetas, campos personalizados, segmentos e sequências.
- Transmissões (envio em massa) e e-mail.
- Importa fluxos copiados da ManyChat (formato de terceiro, veja o aviso acima).
- API pública com chave, documentada em `/api/docs` do motor.

Canais que existem no código: Instagram (login unificado da Meta), WhatsApp oficial (Cloud API da Meta), WhatsApp não oficial (UAZAPI e Z-API, por QR code), Telegram e e-mail. O canal Messenger está congelado (código existe, mas fora de uso).

## O que ele NÃO faz

- Não tem cobrança, planos, carteira nem limites por plano: é um sistema de uso próprio, sem venda embutida.
- Não tem TikTok. Não há integração com o TikTok no código.
- As integrações Google Sheets, Hotmart e Pixel existem no código, mas estão escondidas no painel.
- Não vem com contas, números, tokens ou dados reais de ninguém. Você usa os seus.
- Não substitui a revisão da Meta: para atender o público em geral pelo Instagram e pelo WhatsApp oficial, o seu app da Meta precisa passar pela aprovação deles (veja "Conectar os canais").

## O que você precisa

- **Node.js 22.18 ou mais novo** e npm (versão pedida em `app-vite/README.md`).
- **Conta na Cloudflare** (para publicar; para rodar no seu computador não precisa de login). O sistema usa D1 (banco), R2 (arquivos), Queues (fila), Workflows, Durable Objects, tarefas agendadas e envio de e-mail. Se o plano gratuito basta, **confira** nos limites atuais da Cloudflare; para uso real conte com o plano pago do Workers.
- **Para Instagram e WhatsApp oficial:** um app na Meta (developers.facebook.com), conta de Instagram profissional e/ou número de WhatsApp Business, e os tokens que a Meta gera.
- **Para Telegram:** um bot criado no @BotFather.
- **Para WhatsApp não oficial:** uma conta UAZAPI ou Z-API sua. Esse tipo de conexão não é oficial do WhatsApp e pode levar ao bloqueio do número.

## Rodar no seu computador

Nada aqui publica na Cloudflare nem exige login nela.

1. Instale as dependências, uma pasta de cada vez:

   ```sh
   cd engine && npm ci
   cd ../app-vite && npm ci
   ```

2. Crie o arquivo de configuração do motor. Copie `engine/.dev.vars.example` para `engine/.dev.vars` e preencha:

   - `APP_ENV=development`
   - `DEV_AUTO_LOGIN=1` (entra sem senha, só no computador local)
   - `DEV_WORKSPACE_ID=demo-workspace` (o espaço criado pelos dados de demonstração)
   - `BETTER_AUTH_SECRET=` um texto aleatório com pelo menos 32 caracteres
   - `BETTER_AUTH_URL=http://localhost:5173`
   - `CONNECTIONS_KEK_V1=` gere com `openssl rand -base64 32`
   - `CONNECTIONS_KEK_ACTIVE=1`

   Os demais campos do exemplo podem ficar em branco. Esse arquivo nunca vai para o Git.

3. Crie o banco local e os dados de demonstração:

   ```sh
   cd engine
   npm run db:migrate
   npm run db:seed
   ```

4. Suba tudo:

   ```sh
   cd ../app-vite
   npm run dev:local
   ```

   O painel abre em http://localhost:5173 e o motor em http://localhost:8788. Ctrl+C encerra os dois.

Para conferir que está tudo certo: `npm run typecheck` e `npm test` dentro de `engine/` e de `app-vite/`.

## Publicar na Cloudflare

Este roteiro foi testado numa conta nova da Cloudflare: do zero ao painel no ar levou cerca de 6 minutos. O plano gratuito da Cloudflare aceita filas, fluxos e armazenamento, com limites; o armazenamento (R2) pede um cartão cadastrado.

Faça nesta ordem: filas, motor, migrações, painel e, só no fim, `BETTER_AUTH_URL`. O endereço do painel só existe depois do primeiro deploy dele. O painel conversa com o motor por uma ligação interna chamada `ENGINE`.

Entre na Cloudflare uma vez com `npx wrangler login`.

**Atenção:** se você tem mais de uma conta na Cloudflare, confira em qual está antes de cada comando. Para fixar, rode `export CLOUDFLARE_ACCOUNT_ID=<id da conta>` no terminal.

**1. Crie as duas filas, antes de tudo.** O motor depende delas:

```sh
cd engine
npx wrangler queues create manycraft-inbound
npx wrangler queues create manycraft-inbound-dlq
```

O banco D1 `manycraft` e os dois buckets R2 (`manycraft-media` e `manycraft-inbound-media`) o Wrangler cria sozinho no primeiro deploy do motor. Só as filas você cria à mão.

**2. Publique o motor e aplique as migrações:**

```sh
npx wrangler deploy
npx wrangler d1 migrations apply DB --remote
```

O motor não tem endereço público (`workers_dev` está desligado). Só o painel o alcança.

**3. Segredos do motor** (dentro de `engine/`, um por vez com `npx wrangler secret put NOME`):

- `BETTER_AUTH_SECRET`: texto aleatório com 32 caracteres ou mais (`openssl rand -base64 32`).
- `CONNECTIONS_KEK_V1`: chave que cifra os tokens dos canais (`openssl rand -base64 32`). **Guarde uma cópia.** Sem ela, os canais conectados não abrem mais.
- `CONNECTIONS_KEK_ACTIVE`: `1`.

**4. Publique o painel:**

```sh
cd ../app-vite
npm run build
npx wrangler deploy
```

No fim, o Wrangler mostra o endereço, algo como `https://manycraft-painel.SEU-SUBDOMINIO.workers.dev`.

**5. Só agora configure `BETTER_AUTH_URL`.** Dentro de `engine/`, rode `npx wrangler secret put BETTER_AUTH_URL` e cole o endereço do painel com `https://`, sem barra no fim. O endereço precisa ser igual ao que você abre no navegador.

**6. Confira que está vivo.** Abra `https://SEU-PAINEL.workers.dev/api/auth/ok`. Deve aparecer `{"ok":true}`. Como o motor não tem endereço próprio, é assim que se confere que painel e motor estão funcionando juntos.

Variáveis opcionais do motor (`wrangler secret put`): `SIGNUP_CLOSED=1` (cadastro só para convidados), `MEDIA_PUBLIC_URL` (endereço público dos arquivos de mídia), `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` (entrar com Google).

### Primeiro acesso e o envio de e-mail

No sistema publicado, você cria a conta na tela de cadastro, e o primeiro login cria o seu espaço de trabalho sozinho.

**O cadastro exige e-mail confirmado, e isso não dá para desligar.** O link de confirmação sai pelo serviço de e-mail da Cloudflare (ligação `EMAIL`). Para funcionar:

1. Tenha um domínio seu na Cloudflare.
2. Habilite o Email Service para esse domínio no painel da Cloudflare.
3. Defina `EMAIL_FROM` com um endereço desse domínio: `npx wrangler secret put EMAIL_FROM`, por exemplo `no-reply@seudominio.com`.

Os três passos acima **não foram testados por nós com envio real**; confira os requisitos na Cloudflare.

**O que você vê sem isso:** o cadastro parece dar certo, mas o e-mail não sai. Ao entrar, aparece "e-mail não verificado", e reenviar a confirmação dá erro. Para ver o motivo, rode `npx wrangler tail manycraft-engine` e tente de novo:

- `Envio de e-mail não configurado`: falta `EMAIL_FROM`.
- `domain was not found`: o domínio de `EMAIL_FROM` não está na sua conta Cloudflare.

Cada tentativa gasta a cota de 5 e-mails por hora por destinatário; depois disso o reenvio também dá erro.

**Para você entrar sem o e-mail funcionando (testado por nós):** faça o cadastro na tela e depois marque a sua própria conta como confirmada, direto no seu banco, dentro de `engine/`:

```sh
npx wrangler d1 execute manycraft --remote --command "UPDATE user SET emailVerified=1 WHERE email='seu@email.com'"
```

Volte e entre com e-mail e senha (mínimo de 12 caracteres). Use só para a sua conta. Em seguida defina `SIGNUP_CLOSED=1`, para ninguém mais se cadastrar sem convite, e configure o e-mail de verdade antes de convidar a equipe.

**Publicar uma automação** exige um gatilho, e o gatilho exige um canal conectado. O mais rápido de conectar é o Telegram, em Configurações, Canais.

## Conectar os canais

As conexões são feitas dentro do painel (Configurações, Conexões). Cada uma pede suas credenciais, que ficam cifradas no banco.

- **Telegram:** crie o bot no @BotFather e cole o token do bot. O webhook é registrado automaticamente.
- **Instagram:** pede o token de acesso, o ID da conta do Instagram e a chave secreta do app da Meta. Você precisa de um app na Meta com o caso de uso do Instagram, a conta profissional ligada a ele, as permissões de mensagens e comentários, e o webhook apontando para o endereço do seu painel. Enquanto o app está em modo de desenvolvimento, só administradores e testadores do app conversam com ele. Para atender qualquer pessoa, a Meta exige revisão do app (verificação da empresa e aprovação das permissões), que pode levar tempo e ser recusada. O painel mostra um diagnóstico das permissões que faltam.
- **WhatsApp oficial (Cloud API):** pede token de acesso, ID do número de telefone, ID da conta do WhatsApp Business (opcional) e chave secreta do app, além de um token de verificação (se você deixar em branco, o sistema gera). O webhook é configurado no app da Meta. As regras da Meta valem: fora da janela de 24 horas só se envia modelo de mensagem aprovado, e as mensagens de marketing são cobradas por ela.
- **WhatsApp não oficial (UAZAPI ou Z-API):** pede o endereço do servidor e o token (UAZAPI) ou o ID e o token da instância (Z-API). Sem passar pela Meta, mas sem garantia e com risco para o número.
- **E-mail:** usa o envio de e-mail da Cloudflare, ligado pela ligação `EMAIL`.

Passo a passo detalhado da Meta (criar o app, permissões, webhook) **não está neste repositório**: peça ao Claude Code para conferir a documentação atual da Meta, que muda com frequência.

## Estrutura

- `engine/`: o motor (Cloudflare Worker): banco, fluxos, canais, API.
- `app-vite/`: o painel (React + Vite) e o Worker que o serve.
- `shared/`: código usado pelos dois.
- `replica/contratos/`: exemplos de mensagens da Meta usados como referência nos testes.
- `scripts/`: verificações de qualidade (`npm run check` na raiz roda a bateria completa e é pesado).

## Licença

Este repositório ainda não define uma licença. Sem ela, o código não pode ser reutilizado livremente. Quem publicar o repositório deve escolher uma.
