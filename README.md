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

Faça nesta ordem: motor primeiro, painel depois (o painel conversa com o motor por uma ligação interna chamada `ENGINE`, que aponta para o Worker `manycraft-engine`).

Entre na Cloudflare uma vez: `npx wrangler login`.

**1. Recursos que o motor usa** (definidos em `engine/wrangler.jsonc`):

| Recurso | Nome no arquivo |
|---|---|
| Banco D1 | `manycraft` |
| Arquivos R2 | `manycraft-media` e `manycraft-inbound-media` |
| Filas | `manycraft-inbound` e `manycraft-inbound-dlq` (fila de mensagens que falharam) |
| Workflow | `manycraft-flow` (criado no deploy) |
| Durable Objects | `InboxHub` e `ChannelLimiter` (criados no deploy pela migração do arquivo) |
| Limite de tentativas de login | `RL_AUTH` |
| Envio de e-mail | ligação `EMAIL` |
| Tarefas agendadas | três (uma por dia, uma a cada 5 minutos e uma por minuto) |

O arquivo não traz identificação de banco: o Wrangler deve criar o D1 e os buckets R2 sozinho no primeiro deploy (**confira**; se não criar, use `npx wrangler d1 create manycraft` e `npx wrangler r2 bucket create <nome>`). As filas você cria antes:

```sh
cd engine
npx wrangler queues create manycraft-inbound
npx wrangler queues create manycraft-inbound-dlq
```

**2. Publique o motor e aplique as migrações do banco:**

```sh
npx wrangler deploy
npx wrangler d1 migrations apply DB --remote
```

**3. Segredos do motor.** Cada um com `npx wrangler secret put NOME` dentro de `engine/`:

- `BETTER_AUTH_SECRET`: texto aleatório com 32 caracteres ou mais.
- `CONNECTIONS_KEK_V1`: a chave que cifra os tokens dos canais no banco (`openssl rand -base64 32`). **Guarde uma cópia: sem ela, os canais conectados não abrem mais.**
- `CONNECTIONS_KEK_ACTIVE`: `1`.
- `BETTER_AUTH_URL`: o endereço público do painel (o do passo 4), com `https://`.
- Opcionais: `EMAIL_FROM` e `EMAIL_DEFAULT_DOMAIN` (e-mail), `MEDIA_PUBLIC_URL` (endereço público dos arquivos de mídia), `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` (entrar com Google), `SIGNUP_CLOSED=1` (fecha o cadastro para quem não tem convite).

**4. Publique o painel:**

```sh
cd ../app-vite
npm run build
npx wrangler deploy
```

A configuração do painel liga o endereço `workers.dev` da sua conta, e o Wrangler mostra o endereço no fim. Use esse endereço em `BETTER_AUTH_URL` (passo 3) e publique o motor de novo se mudar o valor. Se preferir um domínio próprio, **confira** como adicionar uma rota ao `app-vite/wrangler.jsonc`. O comando exato de deploy do painel (se o build gera outra configuração) também é para **conferir**.

**5. Primeiro acesso.** Em produção o login automático não existe: crie a conta pela tela de cadastro. O cadastro por e-mail e senha exige verificação por e-mail, então o envio de e-mail da Cloudflare (ou o login com Google) precisa estar configurado antes. **Confira** como habilitar o envio de e-mail na sua conta e o que acontece com o primeiro usuário e o primeiro espaço.

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
