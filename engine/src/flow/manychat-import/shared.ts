import { manychatMessageNodes, manychatSharedContentNodes } from '../../channels/manychat-nodes'
import type { J, ReportItem } from './types'

/**
 * Fluxo compartilhado da ManyChat (resposta de `getSharedFlow`) -> o mesmo formato da área de transferência
 * (`$flowChart: "nodes"`) que `translateClipboard` entende. O formato compartilhado é o "conteúdo" do servidor
 * (flow.contents[] com `_content_oid`, mensagens com `keyboard`), não o do editor: este módulo só reorganiza,
 * sem decidir o que tem equivalente — isso continua no tradutor, que relata o que não entrou.
 */

/** Hash do link compartilhado: `<page_id>_<40 hex>`. */
export const SHARE_HASH = /^\d{1,20}_[0-9a-f]{40}$/

/** Aceita o hash solto ou um link de app.manychat.com (flowPlayerPage, importSharedFlow, getSharedFlow). Devolve null se não for da ManyChat. */
export function parseShareLink(input: string, extra?: RegExp): string | null {
  const value = input.trim()
  if (SHARE_HASH.test(value) || extra?.test(value)) return value
  let url: URL
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'app.manychat.com' || url.port || url.username || url.password) return null
  const fromQuery = url.searchParams.get('share_hash')
  const fromPath = /\/importSharedFlow\/([^/?#]+)\/?$/.exec(url.pathname)?.[1]
  const hash = fromQuery ?? (fromPath ? decodeURIComponent(fromPath) : null)
  return hash && (SHARE_HASH.test(hash) || extra?.test(hash)) ? hash : null
}

/** Para logs e mensagens: nunca o hash inteiro. */
export const maskHash = (hash: string) => `${hash.slice(0, 10)}…`

export type SharedTrigger =
  | { kind: 'comment'; name: string; include: string[]; exclude: string[]; public_replies: string[]; all_posts: boolean; any_comment: boolean }
  | { kind: 'keyword'; name: string; channel: string | null; rules: { condition: KeywordCondition; words: string[] }[]; guessed: boolean; dropped: number }
  | { kind: 'other'; name: string; label: string }

export type Names = { tags: Record<string, { nome: string }>; campos: Record<string, { nome: string; tipo?: string }>; sequencias: Record<string, { nome: string }> }
export type SharedConversion = {
  clipboard: J
  original: J
  names: Names
  triggers: SharedTrigger[]
  channel: string | null
  /** Avisos do próprio formato compartilhado (ex.: ação de botão), somados ao relatório do tradutor. */
  notes: ReportItem[]
  flow: { ns: string | null; name: string | null; shared: boolean; cloning: boolean }
}

/** Tipo de conteúdo compartilhado -> tipo de nó do editor (o que `manychatMessageNodes` conhece). */
const messageTypes = manychatSharedContentNodes
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
const arr = (v: unknown): J[] => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') as J[] : [])
const targetOf = (t: unknown): string | null => (t && typeof t === 'object' && typeof (t as J)._content_oid === 'string' ? (t as J)._content_oid : null)

export function sharedToClipboard(shared: J): SharedConversion {
  const flow = (shared.flow ?? {}) as J
  const ns = typeof flow.ns === 'string' ? flow.ns : null
  const notes: ReportItem[] = []
  const nodesData: J[] = []
  const offsets: Record<string, { x: number; y: number }> = {}
  const coords = (flow.coordinates ?? {}) as Record<string, J>
  let channel: string | null = null

  arr(flow.contents).forEach((content, index) => {
    const id = str(content._content_oid || content.data?._oid) || `c${index}`
    const data = (content.data ?? {}) as J
    const type = str(content.type)
    const caption = str(content.caption)
    const c = coords[id]
    if (c && Number.isFinite(Number(c.x)) && Number.isFinite(Number(c.y))) offsets[id] = { x: Number(c.x), y: Number(c.y) }
    const base = { id, contentId: id, caption, flow: ns, deleted: false }
    const note = (level: ReportItem['level'], code: string, message: string) => notes.push({ level, code, message, node_id: id, caption })
    const blocks: J[] = [], buttons: J[] = []
    let seq = 0
    const uid = (raw: unknown, prefix: string) => { const v = str(raw); return v || `${id}-${prefix}${++seq}` }
    const button = (k: J): string => {
      const bid = uid(k._oid, 'b')
      const t = str(k.type)
      const to = targetOf(k) ?? targetOf(k.target)
      if (arr(k.actions).length) note('loss', 'button_actions', `Ações do botão “${str(k.caption)}” não foram importadas (${arr(k.actions).map(a => str(a.type)).join(', ')}).`)
      buttons.push({ id: bid, type: t === 'content' || t === 'url' ? t : t || 'desconhecido', caption: str(k.caption), url: k.url, targetId: to })
      return bid
    }

    if (type in messageTypes) {
      channel ??= manychatMessageNodes[messageTypes[type]!] ?? null
      const order: string[] = []
      for (const m of arr(data.messages)) {
        const bid = uid(m._oid, 'm')
        const mt = str(m.type)
        const kb = arr(m.keyboard).map(button)
        if (mt === 'text') blocks.push({ id: bid, type: 'text', text: str(m.content?.text), buttons: kb })
        else if (mt === 'delay') blocks.push({ id: bid, type: 'delay', time: Number(m.time) || 0, showTyping: !!m.show_typing })
        else if (mt === 'attachment') {
          const ct = str(m.content?.type), d = (m.content?.data ?? {}) as J
          const url = d.img_big ?? d.url ?? d.file ?? d.video_url ?? d.audio_url ?? d.gif
          blocks.push({ id: bid, type: 'attachment', attachmentType: ct, attachment: { image_url: typeof url === 'string' ? url : undefined, mime: d.mime ?? d.content_type, title: d.title ?? d.name }, buttons: kb })
          if (kb.length) note('loss', 'attachment_buttons', 'Botões presos a uma mídia não foram importados.')
        } else if (mt === 'template') blocks.push({ id: bid, type: 'template', buttons: kb })
        else blocks.push({ id: bid, type: `compartilhado:${mt || 'desconhecido'}` })
        order.push(bid)
      }
      // Respostas rápidas do passo (quando existem no formato compartilhado).
      const quick = arr(data.quick_replies)
      if (quick.length) {
        const qid = `${id}-qr`
        blocks.push({ id: qid, type: 'quick_reply', buttons: quick.map(q => button({ ...q, type: 'content' })), settings: {} })
        order.push(qid)
      }
      nodesData.push({ node: { ...base, nodeType: messageTypes[type], blocks: order, targetId: targetOf(data.target) }, related: { blocks, buttons } })
    } else if (type === 'action_group') {
      const items = arr(data.actions)
      nodesData.push({ node: { ...base, nodeType: 'actionGroup', items, orderedActionItemIds: items.map(a => a._oid), targetId: targetOf(data.target) }, related: { blocks: [], buttons: [] } })
    } else if (type === 'multi_condition' || type === 'condition') {
      const order: string[] = []
      arr(data.conditions).forEach((cond, k) => {
        const bid = uid(cond._oid, `case${k}`)
        blocks.push({ id: bid, type: 'case', filter: cond.filter ?? null, targetId: targetOf(cond.target) })
        order.push(bid)
      })
      const did = `${id}-default`
      blocks.push({ id: did, type: 'default', targetId: targetOf(data.default_target) })
      order.push(did)
      nodesData.push({ node: { ...base, nodeType: 'condition', blocks: order, targetId: null }, related: { blocks, buttons: [] } })
    } else if (type === 'smart_delay') {
      const shift = data.shift_time as J | null
      const node: J = { ...base, nodeType: 'smartDelay', targetId: targetOf(data.target) }
      if (shift && shift.value != null) Object.assign(node, { delayType: 'duration', delayValue: Number(shift.value), delayUnits: str(shift.unit) })
      else if (data.wait_until) Object.assign(node, { delayType: 'date', waitUntil: data.wait_until })
      else node.delayType = 'desconhecido'
      if (data.limit_time) note('attention', 'delay_limit', 'A espera tinha um limite de horário na ManyChat que não foi importado; confira a janela de envio.')
      nodesData.push({ node, related: { blocks: [], buttons: [] } })
    } else if (type === 'goto') {
      const flowNs = data.target?.flow_ns ?? null
      if (data.content_target) note('attention', 'goto_step', 'O “Iniciar fluxo” apontava para um passo específico do outro fluxo; aqui ele começa pelo início.')
      nodesData.push({ node: { ...base, nodeType: 'goto', flowId: flowNs, targetId: null }, related: { blocks: [], buttons: [] } })
    } else if (type === 'split' || type === 'randomizer') {
      const variants = arr(data.variants ?? data.variations)
      const order: string[] = []
      variants.forEach((v, k) => {
        const bid = uid(v._oid ?? v.id, `v${k}`)
        blocks.push({ id: bid, type: 'variant', percent: Number(v.percent ?? v.weight ?? 0), targetId: targetOf(v.target) })
        order.push(bid)
      })
      nodesData.push({ node: { ...base, nodeType: variants.length ? 'split' : `compartilhado:${type}`, blocks: order, randomized: data.randomized === true, targetId: targetOf(data.target) }, related: { blocks, buttons: [] } })
    } else if (type === 'comment' || type === 'note') {
      nodesData.push({ node: { ...base, nodeType: 'comment', text: str(data.text ?? caption) }, related: { blocks: [], buttons: [] } })
    } else {
      nodesData.push({ node: { ...base, nodeType: type || 'desconhecido', targetId: targetOf(data.target) }, related: { blocks: [], buttons: [] } })
    }
  })

  const names: Names = { tags: {}, campos: {}, sequencias: {} }
  for (const t of arr(shared.tags_list)) if (t.tag_id != null && t.tag_name) names.tags[str(t.tag_id)] = { nome: str(t.tag_name) }
  for (const f of arr(shared.custom_fields_list)) {
    const fid = f.field_id ?? f.id, name = f.caption ?? f.name ?? f.title
    if (fid != null && name) names.campos[str(fid)] = { nome: str(name), ...(f.type ? { tipo: str(f.type) } : {}) }
  }
  for (const s of arr(shared.sequences_list)) {
    const sid = s.sequence_id ?? s.id, name = s.name ?? s.title
    if (sid != null && name) names.sequencias[str(sid)] = { nome: str(name) }
  }

  return {
    clipboard: { $flowChart: 'nodes', pageId: flow.page_id != null ? str(flow.page_id) : undefined, data: { nodesData, offsets } },
    original: { flow: { ns, name: flow.name, root_content_id: flow.root_content_id, contents: flow.contents ?? [] } },
    names, triggers: sharedTriggers(flow.triggers), channel, notes,
    flow: { ns, name: typeof flow.name === 'string' ? flow.name : null, shared: flow.is_shared !== false, cloning: flow.shared_cloning_enabled !== false },
  }
}

const splitWords = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : str(v).split(',')).map(w => w.trim()).filter(Boolean)
type KeywordCondition = 'contains' | 'equals' | 'word' | 'starts'
const keywordRules: Record<string, KeywordCondition> = { contains: 'contains', is: 'equals', equals: 'equals', exact: 'equals', begins_with: 'starts', starts_with: 'starts', word: 'word', words: 'word' }

/** Gatilhos do fluxo compartilhado -> o que dá para recriar aqui. Só leitura: quem cria é o motor, que conhece as conexões. */
export function sharedTriggers(raw: unknown): SharedTrigger[] {
  const t = (raw ?? {}) as J
  const out: SharedTrigger[] = []
  for (const w of arr(t.widgets)) {
    const name = str(w.name) || 'Gatilho importado'
    const wt = str(w.widget_type)
    if (wt === 'feed_comment_trigger' || wt === 'feed_comment') {
      const s = (w.data?.feed_comment_settings ?? {}) as J
      const include = [...new Set(splitWords(s.include_keywords_array ?? s.include_keywords))]
      const exclude = [...new Set(splitWords(s.exclude_keywords_array ?? s.exclude_keywords))]
      const replies = (Array.isArray(w.data?.feed_comment_welcome?.public_reply_messages) ? (w.data.feed_comment_welcome.public_reply_messages as unknown[]).map(str).map(r => r.trim()).filter(Boolean) : [])
      out.push({ kind: 'comment', name, include, exclude, public_replies: replies, all_posts: (s.post_covered_area ?? 'all_posts') === 'all_posts' && !Number(s.post_id), any_comment: s.comment_contains === 'any' || (!include.length && s.comment_contains !== 'specific_words') })
    } else out.push({ kind: 'other', name, label: wt || 'widget' })
  }
  for (const k of arr(t.keywords)) {
    const raw = arr(k.keyword_rules).length ? arr(k.keyword_rules) : [{ keywords: k.keywords ?? k.keyword ?? k.caption, condition: k.condition ?? k.rule }]
    let guessed = false
    const rules = raw.map(r => {
      const rule = str(r.condition ?? r.rule).toLowerCase()
      if (!(rule in keywordRules)) guessed = true
      return { condition: keywordRules[rule] ?? 'contains' as KeywordCondition, words: [...new Set(splitWords(r.keywords ?? r.keyword))] }
    }).filter(r => r.words.length)
    const name = str(k.name) || rules.flatMap(r => r.words).slice(0, 3).join(', ') || 'Palavra-chave importada'
    if (!rules.length) { out.push({ kind: 'other', name, label: 'keyword' }); continue }
    out.push({ kind: 'keyword', name, channel: typeof k.channel === 'string' ? k.channel : null, rules: rules.slice(0, 2), guessed, dropped: Math.max(0, rules.length - 2) })
  }
  for (const i of arr(t.intents)) out.push({ kind: 'other', name: str(i.name) || 'Intenção', label: 'intent' })
  for (const r of arr(t.trigger_rules)) out.push({ kind: 'other', name: str(r.name ?? r.title) || 'Regra', label: 'trigger_rule' })
  return out
}
