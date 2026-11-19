# Painel da réplica

Requisitos: Node 22.18+ e dependências instaladas em `app-vite/` e `engine/`.
Nenhum comando abaixo publica Workers ou exige login na Cloudflare.

## Painel e engine reais, locais

Prepare `engine/.dev.vars` conforme o exemplo do motor. O contrato sem login exige
`APP_ENV=development` e `DEV_AUTO_LOGIN=1`, além da configuração do seed e do canal.
Credenciais ficam somente no engine. Não adicione tokens ao ambiente do Vite.
Aplique as migrações e o seed locais do engine, conforme suas instruções, antes de abrir o painel.
Então, dentro de `app-vite/`:

```sh
npm run dev:local
```

O comando inicia Vite em `http://localhost:5173` e Wrangler local do engine em `8788`,
com encerramento conjunto por Ctrl+C. O service binding `ENGINE` resolve o Worker `manycraft-engine`
pelo registro local do Wrangler. A abordagem de dois processos com comunicação pelo binding está
na [documentação oficial sobre múltiplos Workers](https://developers.cloudflare.com/workers/local-development/multi-workers/),
consultada em 23/10/2026. O engine usa o ambiente `dev`, com nome local `manycraft-engine` explícito para coincidir com o binding;
ele precisa conter as rotas W2 do contrato. O registro dos processos fica em `.wrangler/` desta
worktree, sem reutilizar outro engine em execução, e o comando usa polling para evitar
esgotamento de watchers em ambientes com muitas worktrees.

O navegador conecta a `/api/inbox/live?workspace=<id>` porque a API WebSocket não aceita header
customizado. Somente nesse handshake o proxy remove a query `workspace` e a traduz para
`x-workspace`. Cookie, corpo, método e outros parâmetros seguem ao engine, que decide a
identidade e as permissões. O proxy retorna a resposta original, inclusive upgrades 101.
Erros de binding retornam 503 sem detalhes de credenciais; não há fallback silencioso para fake.

## Verificação

```sh
npm run typecheck
npm run build
npm test
npm run test:worker
```

Os testes do proxy verificam transporte HTTP, cookies, workspace, preservação do objeto de upgrade
WebSocket e erro sem vazamento. A validação de WebSocket real exige o runtime local em `dev:local`;
os testes Node não representam um handshake de rede.

## Dados de demonstração e limites

O navegador usa a API por padrão e resolve o workspace por `GET /api/dev/workspace`.
Para usar somente os dados em memória: `VITE_DATA_MODE=fake npm run dev`.
Os testes Node usam fake por padrão; os testes de contrato ativam o transporte real com fetch/socket controlados.

No modo padrão todas as telas (automações, palavras-chave, gatilhos, métricas, contatos, tags e campos)
falam com o engine; os dados em memória (`src/data/seed.ts` e afins) só servem ao modo fake e não entram
no build de produção. Erro HTTP nunca cai para os dados de memória.
`GET /api/team` informa id e papel: os responsáveis aparecem com esses dados disponíveis.

Capturas revisadas da prova local ficam em `evidence/`. Não comprovam envio ao Telegram.
