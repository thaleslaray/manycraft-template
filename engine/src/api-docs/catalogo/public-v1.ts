import type { z } from 'zod'
import type { AreaCatalogo, EntradaCatalogo } from '../tipos'
import {
  v1CreateBotFieldSchema, v1CreateCustomFieldSchema, v1CreateSubscriberSchema, v1CreateTagSchema, v1FireTriggerSchema, v1SendContentByUserRefSchema,
  v1SendContentSchema, v1SendFlowSchema, v1SetBotFieldByNameSchema, v1SetBotFieldSchema, v1SetCustomFieldByNameSchema, v1SetCustomFieldSchema, v1TagRefSchema,
  v1FindByCustomFieldQuerySchema, v1FindByNameQuerySchema, v1GetInfoQuerySchema, v1UserRefQuerySchema,
} from '../../public-api'

// Seção "Formato ManyChat (congelada)": as rotas de /api/public/v1 (chave do espaço, envelope do ManyChat).
// Congelada: não recebe rota nova; o check falha se uma rota montada em /api/public/v1 faltar aqui ou sobrar.
// Toda resposta vem no envelope `{ "status": "success", "data": ... }` (erro: `{ "status": "error", "message": "..." }`).
const v = (metodo: EntradaCatalogo['metodo'], nome: string, resumo: string, corpo?: z.ZodType, exemplo?: unknown): EntradaCatalogo =>
  ({ metodo, caminho: `/api/public/v1/${nome}`, resumo, ...(corpo ? { corpo } : {}), ...(exemplo !== undefined ? { exemplo } : {}) })

/** Conteúdo v2: o formato do bloco dinâmico do ManyChat (`version: "v2"` e `content` com mensagens, ações e respostas rápidas). */
const conteudoV2 = 'O `data` segue o formato do bloco dinâmico do ManyChat (`{ "version": "v2", "content": { "messages": [...], "actions": [...], "quick_replies": [...] } }`): até 10 mensagens, 5 ações (pôr/tirar tag, gravar/apagar campo) e 11 respostas rápidas.'
const conteudoExemplo = { version: 'v2', content: { messages: [{ type: 'text', text: 'Olá! Seu pedido foi aprovado.' }], actions: [{ action: 'add_tag', tag_name: 'cliente' }] } }

export const area: AreaCatalogo = {
  area: 'public-v1',
  nome: 'Formato ManyChat (congelada)',
  descricao: 'Compatível com a API pública do ManyChat. Congelada. Aceita a chave do espaço ou uma chave de perfil com o cabeçalho `x-workspace`.',
  entradas: [
    v('GET', 'page/getInfo', 'Dados do espaço (`data`: id, nome e fuso).'),
    v('GET', 'page/getTags', 'Lista as tags ativas (`data`: lista de { id, name }).'),
    v('POST', 'page/createTag', 'Cria uma tag; obrigatório `name`. Responde 201 com `data`: { id, name }.', v1CreateTagSchema, { name: 'cliente' }),
    v('GET', 'page/getCustomFields', 'Lista os campos personalizados do contato (um valor por contato).'),
    v('GET', 'page/getBotFields', 'Lista os campos da conta (um valor só para o espaço inteiro), com o valor atual em `value`.'),
    v('POST', 'page/createCustomField', 'Cria um campo do contato (um valor por contato); obrigatórios `caption` (o nome) e `type`. Responde 201 com `data`: { id, name, type }.', v1CreateCustomFieldSchema, { caption: 'Plano', type: 'text' }),
    v('POST', 'page/createBotField', 'Cria um campo da conta (um valor só para o espaço inteiro); obrigatórios `name` e `type`, `value` opcional. Responde 201 com `data`: { id, name, type }.', v1CreateBotFieldSchema, { name: 'Cupom do mês', type: 'text', value: 'NOV10' }),
    v('POST', 'page/setBotField', 'Grava o valor de um campo da conta; o campo vai pelo id em `field_id`, o valor em `field_value` (`null` apaga).', v1SetBotFieldSchema, { field_id: 'f-cupom', field_value: 'DEZ15' }),
    v('POST', 'page/setBotFieldByName', 'Grava o valor de um campo da conta; o campo vai pelo nome em `field_name`, o valor em `field_value` (`null` apaga).', v1SetBotFieldByNameSchema, { field_name: 'Cupom do mês', field_value: 'DEZ15' }),
    v('GET', 'page/getFlows', 'Lista as automações (`data`: ns, nome, status e se está publicada).'),
    v('GET', 'page/getGrowthTools', 'Lista os gatilhos (ferramentas de crescimento) com o tipo e a automação.'),
    { ...v('GET', 'subscriber/getInfo', 'Mostra um contato; o id vai na query `subscriber_id`.'), query: v1GetInfoQuerySchema },
    { ...v('GET', 'subscriber/getInfoByUserRef', 'Mostra um contato pela referência do usuário na query `user_ref`.'), query: v1UserRefQuerySchema },
    { ...v('GET', 'subscriber/findByName', 'Busca contatos pelo nome na query `name`.'), query: v1FindByNameQuerySchema },
    { ...v('GET', 'subscriber/findByCustomField', 'Busca contatos pelo valor de um campo do contato (query `field_id` e `field_value`).'), query: v1FindByCustomFieldQuerySchema },
    v('POST', 'subscriber/createSubscriber', 'Cria um contato; obrigatório `phone` ou `email`. Opt-in de e-mail (`has_opt_in_email`) exige `consent_phrase`. Responde 201 com o contato em `data`. O contato nasce sem canal: telefone não cria canal de WhatsApp. Ele ganha canal quando escreve ou quando recebe um modelo por `POST /api/inbox/conversations`; sem canal, `sendFlow`, `sendContent` e `triggers/fire` respondem 409.', v1CreateSubscriberSchema, { first_name: 'Ana', email: 'ana@exemplo.com', has_opt_in_email: true, consent_phrase: 'Aceito receber e-mails.' }),
    v('POST', 'subscriber/addTag', 'Põe uma tag no contato; obrigatórios `subscriber_id` e a tag por id (`tag_id`) ou por nome (`tag_name`).', v1TagRefSchema, { subscriber_id: 'c1', tag_id: 't1' }),
    v('POST', 'subscriber/addTagByName', 'Põe uma tag no contato; obrigatórios `subscriber_id` e a tag por nome (`tag_name`) ou por id (`tag_id`).', v1TagRefSchema, { subscriber_id: 'c1', tag_name: 'cliente' }),
    v('POST', 'subscriber/removeTag', 'Tira uma tag do contato; obrigatórios `subscriber_id` e a tag por id (`tag_id`) ou por nome (`tag_name`).', v1TagRefSchema, { subscriber_id: 'c1', tag_id: 't1' }),
    v('POST', 'subscriber/removeTagByName', 'Tira uma tag do contato; obrigatórios `subscriber_id` e a tag por nome (`tag_name`) ou por id (`tag_id`).', v1TagRefSchema, { subscriber_id: 'c1', tag_name: 'cliente' }),
    v('POST', 'subscriber/setCustomField', 'Grava um campo do contato; obrigatórios `subscriber_id` e `field_id`, valor em `field_value` (`null` apaga).', v1SetCustomFieldSchema, { subscriber_id: 'c1', field_id: 'f-plano', field_value: 'anual' }),
    v('POST', 'subscriber/setCustomFieldByName', 'Grava um campo do contato; obrigatórios `subscriber_id` e `field_name`, valor em `field_value` (`null` apaga).', v1SetCustomFieldByNameSchema, { subscriber_id: 'c1', field_name: 'Plano', field_value: 'anual' }),
    v('POST', 'sending/sendFlow', 'Inicia uma automação publicada e ligada para o contato; obrigatórios `subscriber_id` e `flow_ns` (id da automação). `data`: { run_id }.', v1SendFlowSchema, { subscriber_id: 'c1', flow_ns: 'auto-1' }),
    v('POST', 'triggers/fire', 'Dispara a entrada externa ativa de nome `trigger_name` para o contato `subscriber_id`; `context` grava campos de texto de mesmo nome. `data`: { run_id }. O contato precisa ter canal (ver `createSubscriber`); sem canal, 409.', v1FireTriggerSchema, { subscriber_id: 'c1', trigger_name: 'compra_aprovada', context: { produto: 'Curso X' } }),
    v('POST', 'sending/sendContent', `Envia mensagens ao contato \`subscriber_id\` pela conexão mais recente dele. ${conteudoV2} \`data\`: { run_id }.`, v1SendContentSchema, { subscriber_id: 'c1', data: conteudoExemplo }),
    v('POST', 'sending/sendContentByUserRef', `Envia mensagens a quem chegou por link ou plugin (\`user_ref\`) numa conexão (\`channel_id\`), criando o contato se preciso. ${conteudoV2} \`data\`: { run_id, subscriber_id }.`, v1SendContentByUserRefSchema, { user_ref: 'ref-123', channel_id: 'conn-1', data: conteudoExemplo }),
  ],
}
