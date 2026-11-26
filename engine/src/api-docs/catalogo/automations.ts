import type { AreaCatalogo } from '../tipos'
import { automationDraftDocSchema, rascunhoExemplo, rascunhoResumo } from '../rascunho'
import { automationAnswersQuerySchema, automationConvertSchema, automationCopyToSchema, automationCreateSchema, automationDraftSchema, automationImportSharedSchema, automationListQuerySchema, automationLockSchema, automationPatchSchema, automationShareSchema, automationStatsQuerySchema } from '../../automation-actions'
import { automationTriggerCreateBodySchema, automationTriggerPatchBodySchema } from '../../automation-trigger-actions'
import { metricContactsQuerySchema, triggerMetricsQuerySchema } from '../../trigger-metrics'
import { dataIso } from '../respostas-comuns'
import { z } from 'zod'

const grafo = z.object({ nodes: z.array(z.object({})), edges: z.array(z.object({})) }).describe('Fluxo: passos (`nodes`) e ligações (`edges`), no formato do corpo de `PUT /api/automations/{id}/draft`.')
const automacaoResposta = z.object({
  id: z.string(),
  workspace_id: z.string(),
  folder_id: z.string().nullable().describe('Pasta (`GET /api/folders`); `null` = sem pasta.'),
  name: z.string(),
  status: z.enum(['draft', 'live', 'stopped']).describe('`draft` nunca publicada, `live` ligada, `stopped` pausada.'),
  draft_graph: grafo,
  published_version_id: z.string().nullable(),
  has_unpublished_changes: z.boolean().describe('O rascunho mudou depois da última publicação.'),
  locked: z.boolean().describe('Trancada por dono ou administrador: os demais papéis só leem.'),
  locked_actions: z.string().nullable().describe('Com a trava: ações reservadas, em texto JSON; `null` = todas.'),
  deleted_at: dataIso('Quando foi para a lixeira (ISO 8601, UTC).').nullable(),
  created_at: dataIso(),
  updated_at: dataIso(),
})
const automacaoDaListaResposta = automacaoResposta.extend({
  trigger_count: z.number().int().describe('Gatilhos ativos ou em rascunho.'),
  trigger_summary: z.string().describe('O primeiro gatilho em linguagem natural ("Sem gatilho" quando não há).'),
  trigger_type: z.string().nullable().describe('Tipo do primeiro gatilho (`dm_keyword`, `ig_comment`, `ig_story_reply`, `ref_url`...).'),
  trigger_channel: z.string().nullable().describe('Canal da conexão do primeiro gatilho.'),
  runs: z.number().int().describe('Execuções nos últimos 30 dias.'),
  ctr: z.number().nullable().describe('Cliques sobre envios nos últimos 30 dias, de 0 a 1; `null` sem envio.'),
  delivered: z.number().int().describe('Contatos únicos com mensagem entregue nos últimos 30 dias.'),
  read: z.number().int().describe('Contatos únicos com mensagem lida nos últimos 30 dias.'),
  flow_preview: z.object({}).nullable().describe('Miniatura do mapa (passos e ligações com posição); `null` quando só há o gatilho.'),
})
const gatilhoResposta = z.object({
  id: z.string(),
  workspace_id: z.string(),
  automation_id: z.string(),
  channel_id: z.string().nullable().describe('Conexão do gatilho.'),
  channel_type: z.string().nullable(),
  name: z.string(),
  type: z.string().describe('`dm_keyword`, `ig_comment`, `ig_live_comment`, `ig_story_reply`, `ig_story_mention`, `ref_url`, `ad`, `hotmart`, `api`...'),
  config: z.object({}).describe('Configuração própria do tipo (palavras em `include`/`exclude`, publicação alvo em `target`/`post_id`, respostas públicas...).'),
  active: z.boolean(),
  created_at: dataIso(),
  updated_at: dataIso(),
})

// Área automations: veja em ./index.ts como preencher.
// O grafo do rascunho (PUT /draft): a rota aceita `graph` livre; o documento usa ../rascunho.ts (formato real, com exemplo testado).
export const area: AreaCatalogo = {
  area: 'automations',
  nome: 'Automações',
  descricao: 'Criar, editar, publicar e medir as automações (fluxos).',
  entradas: [
    { metodo: 'GET', caminho: '/api/automations', resumo: 'Lista as automações do espaço, com filtros de status (`draft`, `live`, `stopped`), pasta (`folder_id`, `null` = sem pasta) e busca por nome (`search`). Sem paginação: devolve todas as que não estão na lixeira, da alteração mais recente para a mais antiga, com números dos últimos 30 dias.', query: automationListQuerySchema, resposta: z.array(automacaoDaListaResposta) },
    { metodo: 'POST', caminho: '/api/automations', resumo: 'Cria uma automação vazia em rascunho, opcionalmente dentro de uma pasta.', corpo: automationCreateSchema, exemplo: { name: 'Boas-vindas', folder_id: null } },
    { metodo: 'GET', caminho: '/api/automations/:id', resumo: 'Mostra a automação com o rascunho do fluxo, os gatilhos e a versão publicada.', resposta: z.object({
      automation: automacaoResposta,
      triggers: z.array(gatilhoResposta).describe('Gatilhos ativos ou em rascunho (os desligados de vez ficam de fora). Para o detalhe de cada um, `GET /api/automations/{id}/triggers`.'),
      published_version: z.object({
        id: z.string(), automation_id: z.string(), version: z.number().int(), graph: grafo,
        published_by: z.string().nullable(), created_at: dataIso(),
      }).nullable().describe('Versão no ar; `null` quando nunca foi publicada.'),
    }) },
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
