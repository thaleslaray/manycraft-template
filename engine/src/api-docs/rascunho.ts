// Corpo de PUT /api/automations/:id/draft, SÓ PARA DOCUMENTAÇÃO.
// A rota valida com `automationDraftSchema` ({ graph: unknown }) e, ao salvar, o repositório confere o grafo com
// `graphSchema` (engine/src/schemas/graph.ts). Lá a `config` de cada passo é livre (passthrough); o formato de cada
// tipo só é cobrado ao publicar (questionSchema, smartDelaySchema, flowConditionSchema, actionSchema, buttonBlockSchema...).
// Este schema junta os dois níveis num documento legível: um tipo de passo e um tipo de bloco por variante, com título.
// Mantenha compatível com graphSchema: todo grafo que passa aqui tem de passar lá (o teste confere com o exemplo).
import { z } from 'zod'
import { annotationSchema, buttonBlockSchema, cardBlockSchema, galleryBlockSchema, listBlockSchema, mediaBlockSchema, quickReplyBlockSchema } from '../schemas/graph'
import { questionSchema } from '../schemas/question'
import { flowConditionSchema, smartDelaySchema } from '../schemas/temporal'
import { actionSchema } from '../schemas/actions'
import { dynamicConfigSchema } from '../flow/dynamic-block'

const posicao = z.object({ x: z.number(), y: z.number() }).meta({ description: 'Posição do passo no desenho (só visual).' })
const passo = <T extends string>(tipos: readonly [T, ...T[]], title: string, description: string, config: z.ZodType) =>
  z.object({
    id: z.string().min(1).meta({ description: 'Identificador do passo, único no fluxo; as ligações usam este id.' }),
    type: tipos.length === 1 ? z.literal(tipos[0]) : z.enum(tipos),
    position: posicao,
    config,
  }).meta({ title, description })

const bloco = (schema: z.ZodType, title: string, description: string) => schema.meta({ title, description })
const blocos = z.array(z.union([
  bloco(z.object({ kind: z.literal('text'), text: z.string().meta({ description: 'Texto; aceita variáveis como {{first_name}}.' }) }), 'Bloco de texto', 'Um balão de texto.'),
  bloco(mediaBlockSchema, 'Bloco de mídia', 'Imagem, áudio, vídeo ou arquivo por endereço (`url`).'),
  bloco(buttonBlockSchema, 'Botão', 'Botão do balão anterior. `action.type`: `go_to_node` (segue pela saída `btn:<id>`), `url` (abre o link), `dynamic` ou `start_automation`. `actions` roda ações ao tocar. No Telegram, o `callback_data` do botão é o próprio `id` do botão.'),
  bloco(quickReplyBlockSchema, 'Resposta rápida', 'Opção rápida abaixo da mensagem; ao tocar segue pela saída `btn:<id>`. Sem toque, segue por `next`.'),
  bloco(listBlockSchema, 'Lista de opções', 'Lista com seções e linhas (WhatsApp); cada linha tem saída `btn:<id da linha>`.'),
  bloco(cardBlockSchema, 'Cartão', 'Um cartão com imagem, título e até 3 botões.'),
  bloco(galleryBlockSchema, 'Galeria de cartões', 'Até 10 cartões lado a lado.'),
  bloco(z.object({ kind: z.literal('typing'), seconds: z.number().min(1).max(10) }), 'Digitando', 'Mostra "digitando..." por 1 a 10 segundos antes do próximo balão.'),
  bloco(z.object({ type: z.string().meta({ description: 'Vocabulário nativo (ex.: `text`, `delay`, `cards`).' }) }).catchall(z.unknown()), 'Bloco nativo (importado da ManyChat)', 'Formato com `type` em vez de `kind`, vindo de importação. Para criar fluxos novos use os blocos com `kind`.'),
])).meta({ description: 'Balões e elementos da mensagem, na ordem de envio.' })

const variacoes = z.object({
  variations: z.array(z.object({ id: z.string().min(1).meta({ description: 'Também é o nome da saída deste caminho.' }), weight: z.number().positive() })).min(2).max(6),
  random_every_time: z.boolean().optional().meta({ description: 'false = o contato sempre cai no mesmo caminho. Padrão true.' }),
})

export const tiposDePassoDoc = ['Gatilho (início)', 'Mensagem', 'Atraso', 'Pergunta', 'Condição', 'Ações', 'Randomizador', 'Iniciar automação', 'Modelo de mensagem (WhatsApp)', 'Bloco dinâmico', 'Nota', 'Outros tipos (legado)'] as const
export const tiposDeBlocoDoc = ['Bloco de texto', 'Bloco de mídia', 'Botão', 'Resposta rápida', 'Lista de opções', 'Cartão', 'Galeria de cartões', 'Digitando', 'Bloco nativo (importado da ManyChat)'] as const

const no = z.union([
  passo(['trigger', 'starting_step'], 'Gatilho (início)', 'Onde o fluxo começa. `config` vazio: os gatilhos de verdade (palavra-chave, comentário...) são criados em /triggers. Saída: `next`.', z.object({})),
  passo(['message', 'content', 'default', 'telegram'], 'Mensagem', 'Envia os blocos no canal do contato. Saídas: `next` e uma `btn:<id>` por botão, resposta rápida ou linha de lista.', z.object({ blocks: blocos })),
  passo(['smart_delay'], 'Atraso', 'Espera um tempo (`mode: duration` + `duration`) ou até uma data (`mode: date` + `date`), opcionalmente numa janela de horário. Saída: `next`.', smartDelaySchema),
  passo(['question'], 'Pergunta', 'Pergunta e guarda a resposta no campo `field_id` (campo de contato ou `system:email`, `system:phone`...). Saídas: `success` (resposta válida) e `no_response` (sem resposta no `timeout`).', questionSchema),
  passo(['condition'], 'Condição', 'Confere regras (`match: all|any`, `rules`) sobre etiquetas, campos, data, horário... Saídas: `true` (atende) e `false` (não atende).', flowConditionSchema),
  passo(['action', 'action_group'], 'Ações', 'Roda ações em ordem: etiqueta, campo, sequência, conversa, integração... Saída: `next`.', z.object({ actions: z.array(actionSchema) })),
  passo(['randomizer', 'split'], 'Randomizador', 'Sorteia um caminho pelo peso. Uma saída por variação, com o `id` dela.', variacoes),
  passo(['start_automation', 'goto'], 'Iniciar automação', 'Inicia outra automação publicada e ligada. `wait_for_finish: true` espera ela terminar antes de seguir. Saída: `next`.', z.object({ automation_id: z.string().min(1), wait_for_finish: z.boolean().optional() })),
  passo(['template_message'], 'Modelo de mensagem (WhatsApp)', 'Envia um modelo aprovado (vale fora da janela de 24 h). Só no WhatsApp oficial: em contato de outro canal a execução falha com `template_channel_unsupported`. Saída: `next`.', z.object({ template_id: z.string().min(1).meta({ description: 'Id do modelo aprovado nesta conexão (GET /api/message-templates/:connection).' }), params: z.record(z.string(), z.string()).optional().meta({ description: 'Valores das variáveis: `{"1": "Ana"}` para `{{1}}` do corpo; `header:1` para o cabeçalho; `button:<índice>:1` para a URL de um botão. Aceita variáveis do contato, como `{{first_name}}`.' }) }).catchall(z.unknown())),
  passo(['dynamic'], 'Bloco dinâmico', 'Busca o conteúdo no seu servidor (https) na hora do envio. Saída: `next`.', dynamicConfigSchema),
  passo(['note', 'comment'], 'Nota', 'Comentário no desenho; o motor ignora.', z.object({}).catchall(z.unknown())),
  passo(['email_new', 'whatsapp', 'instagram', 'tiktok', 'conditional', 'multi_condition', 'agent', 'main_menu', 'form', 'persistent_menu'], 'Outros tipos (legado)', 'Tipos aceitos no rascunho por compatibilidade com importações; prefira os tipos acima.', z.object({}).catchall(z.unknown())),
])

const ligacao = z.object({
  from: z.string().meta({ description: 'id do passo de origem.' }),
  port: z.string().meta({ description: 'Saída do passo de origem: `next`; `btn:<id>` (botão/resposta rápida/linha); `success`/`no_response` (pergunta); `true`/`false` (condição); o `id` da variação (randomizador). Cada saída leva a um passo só.' }),
  to: z.string().meta({ description: 'id do passo de destino.' }),
}).meta({ title: 'Ligação', description: 'Liga a saída de um passo à entrada de outro.' })

export const automationDraftDocSchema = z.object({
  graph: z.object({
    nodes: z.array(no).meta({ description: 'Os passos do fluxo. Comece por um passo `trigger`.' }),
    edges: z.array(ligacao).meta({ description: 'As ligações entre os passos.' }),
    annotations: z.array(annotationSchema).max(200).optional().meta({ description: 'Notas adesivas e quadros do desenho (o motor ignora).' }),
  }).meta({ title: 'Fluxo', description: 'Passos (`nodes`) e ligações (`edges`) por porta de saída.' }),
})

/** Gatilho → mensagem com botão → atraso de 1 hora → pergunta (guarda no campo) → condição pela resposta → duas mensagens. */
export const rascunhoExemplo = {
  graph: {
    nodes: [
      { id: 'inicio', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      { id: 'boas-vindas', type: 'message', position: { x: 320, y: 0 }, config: { blocks: [
        { kind: 'text', text: 'Oi, {{first_name}}! Quer conhecer o curso?' },
        { kind: 'button', id: 'quero', label: 'Quero saber', action: { type: 'go_to_node' } },
      ] } },
      { id: 'espera', type: 'smart_delay', position: { x: 640, y: 0 }, config: { mode: 'duration', duration: { value: 1, unit: 'hours' } } },
      { id: 'pergunta', type: 'question', position: { x: 960, y: 0 }, config: {
        text: 'Você prefere aulas ao vivo ou gravadas?', answer_type: 'text', field_id: 'campo-interesse',
        retry_message: 'Não entendi. Responde "ao vivo" ou "gravadas"?', max_attempts: 2, skip: false,
        timeout: { value: 1, unit: 'days' }, choices: [], opt_in: [], consent_phrase: '',
      } },
      { id: 'confere', type: 'condition', position: { x: 1280, y: 0 }, config: { match: 'all', rules: [
        { type: 'field', field_id: 'campo-interesse', operator: 'contains', value: 'vivo' },
      ] } },
      { id: 'ao-vivo', type: 'message', position: { x: 1600, y: -120 }, config: { blocks: [{ kind: 'text', text: 'As turmas ao vivo começam toda segunda às 20h.' }] } },
      { id: 'gravadas', type: 'message', position: { x: 1600, y: 120 }, config: { blocks: [{ kind: 'text', text: 'As aulas gravadas ficam liberadas na hora da compra.' }] } },
    ],
    edges: [
      { from: 'inicio', port: 'next', to: 'boas-vindas' },
      { from: 'boas-vindas', port: 'btn:quero', to: 'espera' },
      { from: 'espera', port: 'next', to: 'pergunta' },
      { from: 'pergunta', port: 'success', to: 'confere' },
      { from: 'confere', port: 'true', to: 'ao-vivo' },
      { from: 'confere', port: 'false', to: 'gravadas' },
    ],
  },
}

export const rascunhoResumo = 'Salva o rascunho do fluxo; só vai ao ar com outra chamada, POST /api/automations/:id/publish. '
  + 'O fluxo é `graph` = { nodes, edges }: cada passo (`nodes`) tem `id`, `type` (trigger, message, smart_delay, question, condition, action, randomizer, start_automation...), `position` e a `config` do tipo; '
  + 'cada ligação (`edges`) leva a saída `port` de um passo (`from`) a outro passo (`to`). Saídas: `next` na maioria; `btn:<id>` em botões e respostas rápidas; `success`/`no_response` na pergunta; `true`/`false` na condição (então/senão); o id da variação no randomizador. '
  + 'Ao salvar, confere a estrutura (tipos de passo e de bloco, ids únicos, ligações para passos que existem) e recusa com 400; a `config` completa de cada passo (pergunta, espera, condição, ações, botões) e as referências a etiquetas e campos só são cobradas ao publicar.'
