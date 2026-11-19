import type { AreaCatalogo } from '../tipos'
import { automationDraftDocSchema, rascunhoExemplo, rascunhoResumo } from '../rascunho'
import { automationAnswersQuerySchema, automationConvertSchema, automationCopyToSchema, automationCreateSchema, automationDraftSchema, automationImportSharedSchema, automationListQuerySchema, automationLockSchema, automationPatchSchema, automationShareSchema, automationStatsQuerySchema } from '../../automation-actions'
import { automationTriggerCreateBodySchema, automationTriggerPatchBodySchema } from '../../automation-trigger-actions'
import { metricContactsQuerySchema, triggerMetricsQuerySchema } from '../../trigger-metrics'

// Área automations: veja em ./index.ts como preencher.
// O grafo do rascunho (PUT /draft): a rota aceita `graph` livre; o documento usa ../rascunho.ts (formato real, com exemplo testado).
export const area: AreaCatalogo = {
  area: 'automations',
  nome: 'Automações',
  descricao: 'Criar, editar, publicar e medir as automações (fluxos).',
  entradas: [
    { metodo: 'GET', caminho: '/api/automations', resumo: 'Lista as automações do espaço, com filtros de status (`draft`, `live`, `stopped`), pasta (`folder_id`, `null` = sem pasta) e busca por nome (`search`).', query: automationListQuerySchema },
    { metodo: 'POST', caminho: '/api/automations', resumo: 'Cria uma automação vazia em rascunho, opcionalmente dentro de uma pasta.', corpo: automationCreateSchema, exemplo: { name: 'Boas-vindas', folder_id: null } },
    { metodo: 'GET', caminho: '/api/automations/:id', resumo: 'Mostra a automação com o rascunho do fluxo e a versão publicada.' },
    { metodo: 'PATCH', caminho: '/api/automations/:id', resumo: 'Renomeia, muda de pasta ou liga/pausa a automação (`live` / `stopped`); mande ao menos um campo.', corpo: automationPatchSchema, exemplo: { status: 'stopped' } },
    { metodo: 'DELETE', caminho: '/api/automations/:id', resumo: 'Exclui de vez uma automação que está na lixeira.' },
    { metodo: 'GET', caminho: '/api/automations/:id/answers', resumo: 'Respostas que os contatos deram às perguntas do fluxo, mais recentes primeiro (até 5.000); `node` filtra uma pergunta e `format=csv` baixa planilha.', query: automationAnswersQuerySchema },
    { metodo: 'GET', caminho: '/api/automations/:id/called-by', resumo: 'Lista as automações que iniciam esta (passo "Iniciar automação").' },
    { metodo: 'POST', caminho: '/api/automations/:id/convert', resumo: 'Cria uma cópia em rascunho para outro canal, sem os gatilhos e sem os blocos que o canal de destino não aceita.', corpo: automationConvertSchema, exemplo: { channel: 'whatsapp' } },
    { metodo: 'POST', caminho: '/api/automations/:id/copy-to', resumo: 'Copia a automação em rascunho para outro espaço onde você pode editar, religando tags e campos de mesmo nome.', corpo: automationCopyToSchema, exemplo: { workspace_id: 'ws-destino' } },
    { metodo: 'PUT', caminho: '/api/automations/:id/draft', resumo: rascunhoResumo, corpo: automationDraftSchema, corpoDoc: automationDraftDocSchema, exemplo: rascunhoExemplo },
    { metodo: 'POST', caminho: '/api/automations/:id/duplicate', resumo: 'Duplica a automação no mesmo espaço, em rascunho.' },
    { metodo: 'POST', caminho: '/api/automations/:id/lock', resumo: 'Tranca ou destranca a automação; `actions` limita o que fica reservado a dono e administrador (sem lista, tudo).', corpo: automationLockSchema, exemplo: { locked: true, actions: ['edit', 'delete'] } },
    { metodo: 'GET', caminho: '/api/automations/:id/metric-contacts', resumo: 'Contatos por trás de uma métrica da automação (execuções, inscrições, enviadas, lidas, cliques...), paginados por cursor.', query: metricContactsQuerySchema },
    { metodo: 'POST', caminho: '/api/automations/:id/publish', resumo: 'Publica o rascunho como nova versão; 409 diz qual passo a conexão do gatilho não consegue entregar. Cartão e galeria são conferidos contra as conexões dos gatilhos: crie o gatilho antes de publicar (sem gatilho compatível, 409 "Escolha uma conexão compatível"). Regras por canal em `GET /api/connections/capabilities` (ex.: galeria precisa de texto antes; no WhatsApp o cartão não mistura botão de link com botão de resposta).' },
    { metodo: 'POST', caminho: '/api/automations/:id/restore', resumo: 'Tira a automação da lixeira.' },
    { metodo: 'POST', caminho: '/api/automations/:id/share', resumo: 'Gera um novo link público da automação (o anterior deixa de valer); `allow_copy` permite salvar a cópia.', corpo: automationShareSchema, exemplo: { allow_copy: true } },
    { metodo: 'DELETE', caminho: '/api/automations/:id/share', resumo: 'Revoga o link público da automação.' },
    { metodo: 'GET', caminho: '/api/automations/:id/stats', resumo: 'Números da automação no período (`period_days`, padrão 30), por passo (`nodes`: enviados, leituras, cliques). `runs` é o maior número de envios confirmados de um passo, não o total de execuções: execução cujo envio falhou não conta. Para execuções iniciadas por gatilho, use `GET /api/trigger-metrics`.', query: automationStatsQuerySchema },
    { metodo: 'POST', caminho: '/api/automations/:id/trash', resumo: 'Manda a automação para a lixeira e cancela as execuções em andamento.' },
    { metodo: 'GET', caminho: '/api/automations/:id/trigger-metrics', resumo: 'Métricas por gatilho da automação no período (`period_days`), opcionalmente de um gatilho só. `delivered` e `read` vêm `null` quando nenhuma conexão envolvida avisa entrega ou leitura (o Telegram não avisa nenhuma das duas; o Instagram só avisa leitura): `null` é "não medido", não zero. `impressions` também é `null` onde o canal não informa exibição.', query: triggerMetricsQuerySchema },
    { metodo: 'GET', caminho: '/api/automations/:id/triggers', resumo: 'Lista os gatilhos da automação (palavras-chave, comentários, stories, links, anúncios, externos...). Gatilhos de mensagem (palavra-chave, comentário, story, DM) exigem conexão no estado `connected`: em `pending`, `error` ou desligada a criação é recusada (400); confirme com `POST /api/connections/:id/refresh`.' },
    { metodo: 'POST', caminho: '/api/automations/:id/triggers', resumo: 'Cria um gatilho na automação; o formato do corpo depende de `type`: `ig_comment`/`ig_live_comment`, `ig_story_reply`/`ig_story_mention`, `ad`, `ig_share_to_dm`, `cart_reply`, `hotmart`, `api`, `ref_url`; sem `type`, palavra-chave (obrigatórios `name`, `connection_id`, `node_id`, `words` e `rule`). O gatilho de palavra-chave nasce desligado: para ligar, `PATCH /api/automations/{id}/triggers/{triggerId}` com `{ "enabled": true }`.', corpo: automationTriggerCreateBodySchema, exemplo: { type: 'api', name: 'compra_aprovada', node_id: 'trigger', enabled: true } },
    { metodo: 'PATCH', caminho: '/api/automations/:id/triggers/:triggerId', resumo: 'Altera um gatilho da automação (ativação, frequência, palavras ou a configuração própria do tipo); o formato aceito é o do tipo do gatilho já criado (comentário, story, link, externo ou palavra-chave).', corpo: automationTriggerPatchBodySchema, exemplo: { enabled: false } },
    { metodo: 'DELETE', caminho: '/api/automations/:id/triggers/:triggerId', resumo: 'Remove um gatilho da automação.' },
    { metodo: 'POST', caminho: '/api/automations/import-shared', resumo: 'Salva no seu espaço, em rascunho, uma automação de um link público que permite cópia.', corpo: automationImportSharedSchema, exemplo: { token: '0123456789abcdef0123456789abcdef0123' } },
  ],
}
