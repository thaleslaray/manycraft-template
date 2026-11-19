import { assertCommentPublishable } from './comment-publish'
import { assertStoryPublishable } from './story-publish'
import { isCards, cardsError, cardsMessage, mergeLeadText, type CardsBlock, type LeadCardsBlock } from '../../schemas/message-cards'
import { storedMedia } from '../../media-blocks'
import { mediaError, type MediaBlock } from '../../schemas/message-media'
import { messageVariables } from '../../schemas/message-variables'
import { HTTPException } from 'hono/http-exception'
import { questionCapabilityError, questionSchema } from '../../schemas/question'
import { isQuickReply, quickRepliesError } from '../../schemas/message-quick-replies'
import { buttonsError } from '../../schemas/message-buttons'
import { isListBlock, listError } from '../../schemas/message-list'
import type { IntegrationEnv } from '../../integrations'
import { resolveAdapter } from '../registry'
import { providers } from '../providers'
import type { OutboundMessage } from '../types'
import { connectionColumns, connectionFromRow, type ConnectionRow } from './connection'
import type { AdapterEnv } from './credentials'

/** D8: publishing is blocked when a step uses something a connection tied to the automation's triggers cannot deliver
 * (replica/arquitetura-mensageria.md §3.2). Each step is fitted, dry, to the effective profile of every target connection;
 * an `unsupported` result is an error that says which feature, in which step, on which connection. Degradations are not errors. */
type Block = Record<string, unknown>
type Issue = { step: string; connection: string; feature: string; detail: string }

const FEATURE: Record<string, string> = { template: 'template de mensagem', cards: 'cartões', list: 'lista', media: 'anexo', text: 'texto' }
const text = (value: unknown) => typeof value === 'string' ? value : ''

/** The neutral messages a step would send. Only what the editor can express: text with buttons, and the native block types it carries. */
function messagesOf(blocks: Block[]): OutboundMessage[] {
  const fakeId = (n: number) => `b:${String(n).padStart(24, '0')}`   // each button gets its own id, as it does when the step runs
  const buttons = blocks.filter(b => b.kind === 'button').map((b, i): Extract<OutboundMessage, { kind: 'text' }>['buttons'] extends (infer A)[] | undefined ? A : never => {
    const action = b.action as { type?: string; url?: string } | undefined
    return action?.type === 'url' ? { type: 'url', title: text(b.label), url: messageVariables(text(action.url)).length ? 'https://example.test/button' : text(action.url) } : { type: 'postback', title: text(b.label), id: fakeId(i) }
  })
  const quickReplies = blocks.filter(isQuickReply).map((b, i) => ({ id: fakeId(1000 + i), title: text(b.label) }))
  const out: OutboundMessage[] = []
  const texts = blocks.filter(b => b.kind === 'text' || b.type === 'text')
  texts.forEach((b, i) => out.push({ kind: 'text', text: text(b.text) || ' ', ...(i === texts.length - 1 && buttons.length ? { buttons } : {}), ...(i === texts.length - 1 && quickReplies.length ? { quickReplies } : {}) }))
  if (!texts.length && (buttons.length || quickReplies.length)) out.push({ kind: 'text', text: ' ', buttons, ...(quickReplies.length ? { quickReplies } : {}) })
  for (const b of blocks) {
    if (b.type === 'template') out.push({ kind: 'template', templateId: 'x', params: {} })
    else if (b.type === 'cards' || b.type === 'card') out.push({ kind: 'cards', cards: [] })
    else if (b.type === 'list') out.push({ kind: 'list', text: ' ', buttonText: 'Ver', sections: [{ rows: [{ id: 'x', title: 'x' }] }] })
    else if (b.type === 'attachment') out.push({ kind: 'media', media: 'file', url: 'https://example.com/x' })
  }
  return out
}

/** Adapter details come in English or terse; the user reads the reason in Portuguese. */
const REASONS: [RegExp, string][] = [
  [/link button cannot share/i, 'o botão de link precisa ficar sozinho na mensagem: não dá para juntá-lo a botões de resposta nem a outro link'],
  [/Only reply buttons/i, 'esta conexão só aceita botões de resposta e um botão de link sozinho'],
  [/link button needs/i, 'o endereço do botão de link precisa ser completo e começar com https:// (ou http://)'],
  [/^List body/i, 'o texto da lista precisa ter de 1 a 1.024 caracteres'],
  [/^List button/i, 'o botão da lista precisa ter de 1 a 20 caracteres'],
  [/^List header and footer/i, 'o cabeçalho e o rodapé da lista aceitam até 60 caracteres'],
  [/^List needs 1 to 10 sections/i, 'a lista precisa de 1 a 10 seções'],
  [/^List needs 1 to 10 rows/i, 'a lista precisa de 1 a 10 linhas no total'],
  [/Every section needs a title/i, 'quando a lista tem várias seções, cada uma precisa de título'],
  [/^List section needs/i, 'cada seção da lista precisa de linhas e de título com até 24 caracteres'],
  [/^List row limits/i, 'as linhas da lista passam do limite: identificador até 200, título até 24 e descrição até 72 caracteres'],
  [/^List row IDs/i, 'os identificadores das linhas da lista precisam ser diferentes'],
  [/unique titles/i, 'os botões da mesma mensagem precisam ter títulos diferentes'],
  [/surrounding spaces/i, 'o identificador do botão não pode ter espaços nas pontas'],
  [/supports text, media, lists/i, 'esta conexão só envia texto, anexo, lista, cartão e galeria, botões de resposta, um botão de link e templates de texto'],
  [/Template requires/i, 'o template precisa de nome da API e idioma'],
]
export const reason = (detail: string) => REASONS.find(([pattern]) => pattern.test(detail))?.[1] ?? detail.replace(/[.\s]+$/, '')

const preview = (blocks: Block[]) => {
  const first = text(blocks.find(b => b.kind === 'text' || b.type === 'text')?.text).trim()
  return first ? `“${[...first].slice(0, 40).join('')}${[...first].length > 40 ? '…' : ''}”` : 'sem texto'
}

/** An explicit connection checks the published version before a menu/starter points to it. */
export async function assertPublishable(env: IntegrationEnv, workspaceId: string, automationId: string, connectionId?: string): Promise<void> {
  const automation = await env.DB.prepare(`SELECT a.draft_graph,v.graph AS published_graph FROM automations a
    LEFT JOIN automation_versions v ON v.workspace_id=a.workspace_id AND v.id=a.published_version_id
    WHERE a.workspace_id=? AND a.id=? AND a.deleted_at IS NULL`).bind(workspaceId, automationId).first<{ draft_graph: string; published_graph: string | null }>()
  if (!automation) return                                    // the repository reports a missing automation itself
  await assertCommentPublishable(env, workspaceId, automationId, automation.draft_graph)
  await assertStoryPublishable(env, workspaceId, automationId)
  const triggers = connectionId ? [{ channel_id: connectionId, audience: 'direct' }] : (await env.DB.prepare(`
    SELECT DISTINCT channel_id,audience FROM triggers WHERE workspace_id=? AND automation_id=? AND status<>'disabled'
    UNION SELECT s.connection_id AS channel_id,'direct' AS audience FROM conversation_surfaces s,json_each(s.published,'$.items') i
    WHERE s.workspace_id=? AND json_extract(s.published,'$.enabled')=1 AND json_extract(i.value,'$.automation_id')=?`)
    .bind(workspaceId, automationId, workspaceId, automationId).all<{ channel_id: string | null; audience: string }>()).results
  // O canal fixo de um gatilho vale pelo próprio perfil mesmo desconectado (reconectar não muda o que ele entrega); gatilho sem canal escuta só os conectados.
  const live = await env.DB.prepare(`SELECT ${connectionColumns}, status AS channel_status FROM channels WHERE workspace_id=? AND archived_at IS NULL ORDER BY created_at,id`)
    .bind(workspaceId).all<ConnectionRow & { channel_status: string }>()
  const everything = triggers.some(t => t.channel_id === null)
  const wanted = new Set(triggers.map(t => t.channel_id))
  // Where a group trigger listens, the answer goes to the group as plain text: a button there could never be clicked.
  const inGroups = new Set(triggers.filter(t => t.audience === 'group').map(t => t.channel_id))
  const triggerTargets = live.results.filter(row => wanted.has(row.id) || everything && row.channel_status === 'connected')
  let graph: { nodes?: { type?: string; config?: Record<string, unknown> }[] }
  try { graph = JSON.parse((connectionId ? automation.published_graph : automation.draft_graph) ?? '') } catch { return }
  const issues: Issue[] = []
  // Cada problema de passo entra aqui: a pessoa vê todos de uma vez, não um por tentativa de publicar.
  const problems: string[] = []
  for (const node of graph.nodes ?? []) {
    const question = node.type === 'question' ? questionSchema.safeParse(node.config) : undefined
    if (question?.success) {
      for (const row of triggerTargets) {
        const detail = inGroups.has(null) || inGroups.has(row.id) ? 'Perguntas de captura exigem conversa privada.' : questionCapabilityError(question.data, connectionFromRow(row).profile)
        if (detail) issues.push({ step: question.data.text, feature: 'pergunta', detail, connection: row.display_name || row.id })
      }
    }
    const blocks = Array.isArray(node.config?.blocks) ? node.config.blocks.filter((b): b is Block => typeof b === 'object' && b !== null) : []
    if (!blocks.length || node.type === 'trigger') continue
    // Um passo com canal escolhido só vale para as conexões desse canal: as dos gatilhos de outros canais não o recebem.
    const stepChannel = typeof node.config?.channel === 'string' && node.config.channel !== 'pending' ? node.config.channel : undefined
    const targets = stepChannel ? live.results.filter(row => row.type === stepChannel && (wanted.has(row.id) || row.channel_status === 'connected')) : triggerTargets
    if (blocks.some(b => b.kind === 'button')) {
      const error = buttonsError(blocks, targets.map(row => connectionFromRow(row).profile))
      if (error) problems.push(`Não dá para publicar: botões no passo ${preview(blocks)}. ${error}`)
    }
    if (blocks.some(isQuickReply)) {
      const error = quickRepliesError(blocks, targets.map(row => connectionFromRow(row).profile), node.config as Parameters<typeof quickRepliesError>[2])
      if (error) problems.push(`Não dá para publicar: respostas rápidas no passo ${preview(blocks)}. ${error}`)
    }
    if (blocks.some(isListBlock)) {
      const error = listError(blocks, targets.map(row => connectionFromRow(row).profile))
      if (error) problems.push(`Não dá para publicar: lista de opções no passo ${preview(blocks)}. ${error}`)
    }
    const cardBlocks = blocks.filter(isCards) as CardsBlock[]
    if (cardBlocks.length && !targets.length) problems.push('Escolha uma conexão compatível com card e galeria no gatilho.')
    // Where a gallery is a carousel, the text right before it is its opening message: check each connection with the blocks it would really send.
    for (const block of cardBlocks) for (const row of targets) {
      const merged = mergeLeadText(blocks, connectionFromRow(row).profile).filter(isCards).find(b => b.cards === block.cards) as LeadCardsBlock | undefined
      const error = cardsError(merged ?? block, [connectionFromRow(row).profile])
      if (error) problems.push(`Não dá para publicar na conexão ${row.display_name || row.id}: ${error}`)
    }
    const mediaBlocks: MediaBlock[] = []
    for (const raw of blocks.filter(b => b.kind === 'media')) {
      const block = await storedMedia(env, workspaceId, raw as MediaBlock)
      const error = mediaError(block, targets.map(row => connectionFromRow(row).profile))
      if (error) { problems.push(`Não dá para publicar: anexo no passo ${preview(blocks)}. ${error}`); continue }
      mediaBlocks.push(block)
    }
    // Variables stand for a typical value: the real one is checked again when the step runs.
    const sample = (b: CardsBlock) => cardsMessage({ ...b, cards: b.cards.map(c => ({ ...c, title: messageVariables(c.title).length ? 'Título' : c.title, subtitle: c.subtitle && messageVariables(c.subtitle).length ? 'Subtítulo' : c.subtitle, imageUrl: c.imageUrl && messageVariables(c.imageUrl).length ? 'https://media.example.test/image.png' : c.imageUrl, actionUrl: c.actionUrl && messageVariables(c.actionUrl).length ? 'https://example.test/card' : c.actionUrl, buttons: c.buttons?.map(button => ({ ...button, title: messageVariables(button.title).length ? 'Abrir' : button.title, ...(button.type === 'url' && messageVariables(button.url).length ? { url: 'https://example.test/button' } : {}) })) })) })
    const fixed = [...messagesOf(blocks), ...mediaBlocks.map((b): OutboundMessage => ({ kind: 'media', media: b.media,
      url: messageVariables(b.url).length ? 'https://media.example.test/variable' : b.url, size: b.size, mime: b.mime }))]
    for (const row of targets) {
      const connection = connectionFromRow(row)
      const adapter = resolveAdapter(connection.kind, row.provider, { ...env } as AdapterEnv)
      const messages = [...fixed, ...mergeLeadText(blocks, connection.profile).filter(isCards).map(sample)]
      for (const message of messages) {
        const note = (feature: string, detail: string) => issues.push({ step: preview(blocks), feature, detail,
          connection: `${row.display_name || providers[connection.provider].label} (${providers[connection.provider].label})` })
        if (message.kind === 'template') { if (!connection.profile.templates) note(FEATURE.template, 'esta conexão não usa templates aprovados'); continue }
        if (message.kind === 'text' && message.buttons?.length && (inGroups.has(null) || inGroups.has(row.id))) { note('botões', 'em grupo a resposta sai só como texto'); continue }
        const fitted = adapter.fit(message, connection.profile)
        if ('ok' in fitted && !fitted.ok) note(message.kind === 'text' && message.buttons?.length ? 'botões' : FEATURE[message.kind] ?? message.kind, fitted.detail)
      }
    }
  }
  if (issues.length) {
    const lines = issues.slice(0, 3).map(i => `${i.feature} na mensagem ${i.step} não funciona na conexão ${i.connection}: ${reason(i.detail)}`)
    problems.push(`Não dá para publicar: ${lines.join('; ')}${issues.length > 3 ? ` (e mais ${issues.length - 3})` : ''}. Tire o recurso ou desligue o gatilho dessa conexão.`)
  }
  if (problems.length) throw new HTTPException(409, { message: problems.join(' ') })
}
