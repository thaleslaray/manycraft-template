import { manychatMessageNodes } from '../../channels/manychat-nodes'
import { translateActions } from './actions'
import { translateFilter } from './condition'
import { addBlock, clamp, durationOf, type BlockContext, type MessageSeg } from './message'
import type { MediaResolver } from './media'
import { translateVariables, type VarHooks } from './vars'
import { clipboardSchema, type GraphEdge, type GraphNode, type ImportReport, type ImportedGraph, type J, type RefResolver, type ReportItem } from './types'

export type TranslateOptions = { refs: RefResolver; original?: unknown; name?: string; media?: MediaResolver }
export type TranslateResult = { graph: ImportedGraph; report: ImportReport; entry: string | null; name: string }
const STEP = 380
const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const pad = (n: number) => String(n).padStart(2, '0')

/** Clipboard da ManyChat (`$flowChart: "nodes"`) -> grafo nosso + relatório. Função pura: referências chegam já resolvidas em `refs`. */
export function translateClipboard(input: unknown, opts: TranslateOptions): TranslateResult {
  const clip = clipboardSchema.parse(input)
  const { refs } = opts
  const original = (opts.original ?? null) as J | null
  const nodes: GraphNode[] = [], edges: GraphEdge[] = [], items: ReportItem[] = []
  const unsupported: Record<string, number> = {}
  const media: { node_id: string; url: string }[] = []
  const seenWarn = new Set<string>()
  let current: J = {}
  const add = (level: ReportItem['level'], code: string, message: string, node: J = current) => {
    const key = `${node.id}|${code}|${message}`
    if (seenWarn.has(key)) return
    seenWarn.add(key)
    items.push({ level, code, message, node_id: node.id, caption: node.caption })
  }
  const unsup = (label: string) => { unsupported[label] = (unsupported[label] ?? 0) + 1 }
  const hooks: VarHooks = { field: id => refs.field(id), warn: (code, message) => add('attention', code, message) }
  const text = (v: unknown) => translateVariables(String(v ?? ''), hooks)

  // Nós apagados saem; ids repetidos (acontece em exportações antigas) ganham sufixo para o grafo ficar válido.
  const live = clip.data.nodesData.filter(x => (x.node as J).deleted !== true)
  const used = new Set<string>()
  const idOf = new Map<J, string>()
  for (const x of live) {
    let id = x.node.id
    for (let k = 2; used.has(id); k++) { id = `${x.node.id}~d${k}`; add('loss', 'duplicate_id', 'Id repetido no arquivo de origem: o passo repetido recebeu outro id.', x.node as J) }
    used.add(id); idOf.set(x.node as J, id)
  }
  const pos = (id: string) => clip.data.offsets[id] ?? { x: 0, y: 0 }
  const put = (id: string, type: string, base: { x: number; y: number }, config: Record<string, unknown>, step = 0, row = 0) =>
    nodes.push({ id, type, position: { x: base.x + STEP * step, y: base.y + 220 * row }, config })
  const link = (from: string, port: string, to: unknown) => { if (typeof to === 'string' && to) edges.push({ from, port, to }) }
  const note = (id: string, base: { x: number; y: number }, label: string, step = 0, row = 0) =>
    put(id, 'note', base, { text: `Não importado: ${label}`, imported_unsupported: label }, step, row)

  const templates = new Map<string, { body: string }>()
  for (const content of (original?.flow?.contents ?? []) as J[]) for (const m of (content.data?.messages ?? []) as J[]) {
    if (m.type === 'template' && typeof m.content?.body === 'string' && m._oid) templates.set(String(m._oid), { body: m.content.body })
  }

  for (const x of live) {
    const n = x.node as J, id = idOf.get(n)!, base = pos(n.id)
    current = { ...n, id }
    const type = String(n.nodeType)
    if (type in manychatMessageNodes) message(x, id, base, manychatMessageNodes[type])
    else if (type === 'actionGroup') {
      const out = translateActions(n.items ?? [], n.orderedActionItemIds, refs, hooks)
      for (const o of out.notes) add(o.level, o.code, o.message)
      out.unsupported.forEach(unsup)
      const noteId = out.actions.length || !out.unsupported.length ? `${id}~u` : id
      if (out.actions.length || !out.unsupported.length) {
        put(id, 'action', base, { actions: out.actions })
        if (out.unsupported.length) { note(noteId, base, [...new Set(out.unsupported)].join(', '), 1); link(id, 'next', noteId); link(noteId, 'next', n.targetId) }
        else link(id, 'next', n.targetId)
      } else { note(id, base, [...new Set(out.unsupported)].join(', ')); link(id, 'next', n.targetId) }
      if (out.unsupported.length) add('loss', 'action_unsupported', `Ações sem equivalente: ${[...new Set(out.unsupported)].join(', ')}.`)
    } else if (type === 'condition') condition(x, id, base)
    else if (type === 'smartDelay') delay(n, id, base)
    else if (type === 'split') split(x, id, base)
    else if (type === 'goto') {
      const target = n.flowId ? refs.automation(String(n.flowId)) : null
      put(id, 'start_automation', base, { automation_id: target ?? '', source_flow_ns: n.flowId ?? null })
      if (!target) add('attention', 'goto_unresolved', 'O fluxo de destino ainda não foi importado; ao importá-lo, a ligação é completada.')
      link(id, 'next', n.targetId)
    } else if (type === 'comment') put(id, 'note', base, { text: String(n.text ?? ''), ...(n.color ? { color: n.color } : {}) })
    else {
      unsup(`node:${type}`); note(id, base, `node:${type}`); link(id, 'next', n.targetId)
      add('loss', 'node_unsupported', `Passo do tipo ${type} não importado; virou uma nota que apenas segue adiante.`)
    }
  }

  function message(x: J, id: string, base: { x: number; y: number }, channel: string) {
    const n = x.node as J
    const byId = new Map<string, J>((x.related.blocks as J[]).map(b => [b.id, b]))
    const ctx: BlockContext = { byId, buttons: new Map((x.related.buttons as J[]).map(b => [b.id, b])), templates, refs, hooks, media: opts.media }
    type Part = { kind: 'message'; seg: MessageSeg } | { kind: 'question'; block: J }
    const parts: Part[] = []
    const fresh = (): MessageSeg => ({ blocks: [], ports: [], dropped: [], media: [], notes: [] })
    let seg = fresh()
    const dropped: string[] = []
    const flush = () => { dropped.push(...seg.dropped); if (seg.blocks.some(b => ['text', 'media', 'card', 'gallery'].includes(b.kind))) parts.push({ kind: 'message', seg }); else if (seg.blocks.length) add('info', 'empty_segment', 'Trecho sem texto, mídia nem card foi descartado.'); seg = fresh() }
    for (const bid of (n.blocks ?? []) as string[]) {
      const b = byId.get(bid)
      if (!b) continue
      if (b.type === 'question') { flush(); parts.push({ kind: 'question', block: b }); continue }
      addBlock(seg, b, ctx)
    }
    flush()
    const first = (k: number) => k === 0 ? id : `${id}~${k}`
    if (!parts.length) {
      const labels = [...new Set(dropped)].map(l => l.replace(/^block:/, ''))
      if (labels.length) { labels.forEach(l => unsup(`block:${l}`)); note(id, base, labels.join(', ')); add('loss', 'block_unsupported', `Conteúdo sem equivalente: ${labels.join(', ')}.`) }
      else { put(id, 'note', base, { text: 'Mensagem vazia na origem.' }); add('info', 'empty_message', 'Mensagem sem conteúdo importável.') }
      link(id, 'next', n.targetId)
      return
    }
    parts.forEach((part, k) => {
      const pid = first(k), last = k === parts.length - 1, nextId = last ? null : first(k + 1)
      if (part.kind === 'message') {
        const s = part.seg
        put(pid, 'message', base, { channel, blocks: s.blocks, ...(s.clickTimeout ? { click_timeout: s.clickTimeout } : {}), ...(s.replyAttempts ? { reply_attempts: s.replyAttempts } : {}) }, k)
        for (const [port, to] of s.ports) link(pid, port, to)
        s.media.forEach(url => media.push({ node_id: id, url }))
        if (s.media.length && !opts.media) add('attention', 'media_url', `Mídia mantida com o endereço original da ManyChat (${s.media.length}); ainda não foi copiada para o nosso armazenamento.`)
        for (const o of s.notes) add(o.level, o.code, o.message)
        const flat = s.blocks
        const lastSendable = flat.reduce((acc, b, i) => ['text', 'media', 'card', 'gallery'].includes(b.kind) ? i : acc, -1)
        if (flat.some((b, i) => b.kind === 'text' && flat[i + 1]?.kind === 'button' && i < lastSendable && flat.slice(i + 1, lastSendable + 1).some(c => c.kind !== 'button' && c.kind !== 'typing'))) add('attention', 'buttons_reposition', 'Botões de um texto que não é o último da mensagem passam a acompanhar o último texto.')
        if (flat.some(b => b.kind === 'button') && flat.some(b => b.kind === 'quick_reply')) add('attention', 'buttons_and_quick_replies', 'A mensagem mistura botões e respostas rápidas; separe em duas mensagens antes de publicar.')
        if (nextId) link(pid, 'next', nextId)
        else tail(pid, 'next', n.targetId)
      } else {
        const q = part.block
        const kinds: Record<string, string> = { free_text: 'text', email: 'email', phone: 'phone', number: 'number', multiple_choice: 'multiple_choice', date: 'date', datetime: 'date', url: 'url', first_name: 'text', last_name: 'text' }
        const answer = kinds[String(q.replyType)]
        const success = q.targetId ?? n.targetId
        if (!answer) {
          unsup(`question[${q.replyType}]`); note(pid, base, `pergunta (${q.replyType})`, k)
          add('loss', 'question_unsupported', `Pergunta do tipo ${q.replyType} não importada.`)
          if (nextId) link(pid, 'next', nextId); else tail(pid, 'next', success)
          return
        }
        // Campo do sistema da ManyChat: nome/sobrenome pelo tipo da pergunta; e-mail e telefone pelos sinalizadores.
        const system = q.customFieldId != null ? undefined
          : q.replyType === 'first_name' ? 'system:first_name' : q.replyType === 'last_name' ? 'system:last_name'
          : q.replyType === 'email' && q.saveEmailToSystemField ? 'system:email'
          : q.replyType === 'phone' && Object.keys(q).some(k => /^savePhoneTo\w*SystemField$/.test(k) && q[k]) ? 'system:phone' : undefined
        if (q.customFieldId == null && !system) add('attention', 'question_no_field', 'Pergunta sem campo de destino: escolha o campo antes de publicar.')
        const choices = ((q.buttons ?? []) as string[]).map(b => ctx.buttons.get(b)).filter((b): b is J => !!b && b.type === 'answer').map(b => text(b.caption))
        put(pid, 'question', base, {
          text: text(q.text), answer_type: answer, field_id: q.customFieldId != null ? refs.field(String(q.customFieldId)).id : system ?? '',
          retry_message: text(q.validationErrorMessage) || 'Resposta inválida. Tente novamente.',
          max_attempts: clamp(Math.floor(Number(q.answerRetries) || 0) + 1, 1, 10), skip: !!q.skipButtonCaption,
          timeout: durationOf(q.questionAnswerTimeout, { value: 24, unit: 'hours' }), choices: answer === 'multiple_choice' ? choices : [],
        }, k)
        const child = ((q.blocks ?? []) as string[]).map(b => byId.get(b)).find(b => b?.type === 'question_timeout')
        link(pid, 'no_response', child?.targetId)
        if (nextId) link(pid, 'success', nextId); else tail(pid, 'success', success)
      }
    })
    function tail(from: string, port: string, to: unknown) {
      const labels = [...new Set(dropped)]
      if (!labels.length) { link(from, port, to); return }
      const noteId = `${id}~u`
      labels.forEach(l => unsup(l))
      note(noteId, base, labels.map(l => l.replace(/^block:/, '')).join(', '), parts.length)
      link(from, port, noteId); link(noteId, 'next', to)
      add('loss', 'block_unsupported', `Conteúdo sem equivalente: ${labels.map(l => l.replace(/^block:/, '')).join(', ')}.`)
    }
  }

  function condition(x: J, id: string, base: { x: number; y: number }) {
    const blocks = ((x.node.blocks ?? []) as string[]).map(b => (x.related.blocks as J[]).find(r => r.id === b)).filter((b): b is J => !!b)
    const def = blocks.find(b => b.type === 'default')
    const chain: { condition: object; target: unknown }[] = []
    let row = 0
    for (const c of blocks.filter(b => b.type === 'case')) {
      const result = translateFilter(c.filter, refs)
      if ('unsupported' in result) {
        const label = `condition[${result.unsupported.join('; ')}]`
        unsup(label); add('loss', 'condition_unsupported', `Condição sem equivalente (${result.unsupported.join('; ')}); o caminho ficou solto, ligado a uma nota.`)
        const nid = `${id}~x${++row}`
        note(nid, base, label, 1, row); link(nid, 'next', c.targetId)
        continue
      }
      chain.push({ condition: result.condition, target: c.targetId })
    }
    if (!chain.length) {
      if (row) { note(id, base, 'condição'); link(id, 'next', def?.targetId) }
      else { put(id, 'condition', base, { match: 'all', rules: [] }); link(id, 'true', def?.targetId) }
      return
    }
    chain.forEach((c, k) => {
      const cid = k === 0 ? id : `${id}~c${k + 1}`
      put(cid, 'condition', base, c.condition as Record<string, unknown>, k)
      link(cid, 'true', c.target)
      link(cid, 'false', k < chain.length - 1 ? `${id}~c${k + 2}` : def?.targetId)
    })
  }

  function delay(n: J, id: string, base: { x: number; y: number }) {
    const value = Math.floor(Number(n.delayValue)), unit = String(n.delayUnits)
    let config: Record<string, unknown> | null = null
    if (n.delayType === 'duration' && value >= 1 && ['seconds', 'minutes', 'hours', 'days'].includes(unit)) config = { mode: 'duration', duration: { value, unit } }
    else if (typeof n.waitUntil?.value === 'string' && n.waitUntil.is_formula !== true && /^\d{4}-\d{2}-\d{2}/.test(n.waitUntil.value)) config = { mode: 'date', date: { kind: 'specific', at: n.waitUntil.value } }
    if (!config) {
      unsup(`smartDelay[${n.delayType}]`); note(id, base, `espera (${n.delayType})`); link(id, 'next', n.targetId)
      add('loss', 'delay_unsupported', 'Espera por fórmula ou data variável não importada; virou uma nota que apenas segue adiante.')
      return
    }
    const [from, to] = (n.sendingInterval ?? []) as number[]
    const days = ((n.weekdays ?? []) as string[]).map(d => dayNames.indexOf(d)).filter(d => d >= 0)
    if (n.useTimeWindow && Number.isInteger(from) && Number.isInteger(to) && from < to && days.length && !(from === 0 && to >= 24 && days.length === 7)) {
      config.window = { from: `${pad(from)}:00`, to: to >= 24 ? '23:59' : `${pad(to)}:00`, days: [...new Set(days)] }
    }
    put(id, 'smart_delay', base, config); link(id, 'next', n.targetId)
  }

  function split(x: J, id: string, base: { x: number; y: number }) {
    const variants = ((x.node.blocks ?? []) as string[]).map(b => (x.related.blocks as J[]).find(r => r.id === b)).filter((b): b is J => !!b && b.type === 'variant' && Number(b.percent) > 0)
    if (variants.length < 2) {
      put(id, 'note', base, { text: 'Divisão com um único caminho ativo.' }); link(id, 'next', variants[0]?.targetId)
      add('attention', 'split_single', 'Divisão com menos de dois caminhos ativos virou nota que segue adiante.')
      return
    }
    put(id, 'randomizer', base, { variations: variants.slice(0, 6).map(v => ({ id: v.id, weight: Number(v.percent) })), random_every_time: true })
    for (const v of variants.slice(0, 6)) link(id, v.id, v.targetId)
    if (x.node.randomized === true) add('attention', 'split_randomized', 'A divisão tinha a opção “randomized” ligada; confira se o sorteio por contato continua como esperado.')
  }

  // Ligações para passos que não existem mais não podem ficar no grafo.
  const ids = new Set(nodes.map(n => n.id))
  const kept = edges.filter(e => {
    const ok = ids.has(e.from) && ids.has(e.to)
    if (!ok) add('loss', 'dangling_target', 'Uma ligação apontava para um passo que não está no arquivo e foi descartada.', { id: e.from })
    return ok
  })
  // Entrada: o original diz qual é; sem ele, vale o único passo que ninguém aponta.
  const root = original?.flow?.root_content_id
  const byContent = root != null ? live.find(x => String((x.node as J).contentId) === String(root)) : undefined
  const pointed = new Set(kept.map(e => e.to))
  const roots = nodes.filter(nd => nd.type !== 'note' && !nd.id.includes('~') && !pointed.has(nd.id))
  let entry: string | null = byContent ? idOf.get(byContent.node as J)! : roots.length === 1 ? roots[0].id : null
  if (!entry) {
    const ordered = [...(roots.length ? roots : nodes.filter(nd => nd.type !== 'note'))].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
    entry = ordered[0]?.id ?? null
    if (entry) add('attention', 'entry_guess', `Não deu para saber qual é o primeiro passo (${roots.length} candidatos); foi escolhido o mais à esquerda.`, { id: entry })
  }
  const entryNode = nodes.find(nd => nd.id === entry)
  const left = nodes.length ? Math.min(...nodes.map(nd => nd.position.x)) : 0
  const graphNodes: GraphNode[] = [{ id: 'trigger', type: 'trigger', position: { x: left - 420, y: entryNode?.position.y ?? 0 }, config: {} }, ...nodes]
  if (entry) kept.unshift({ from: 'trigger', port: 'next', to: entry })
  const ns = (original?.flow?.ns ?? (live[0]?.node as J | undefined)?.flow ?? null) as string | null
  const summary = { loss: 0, attention: 0, info: 0 }
  for (const i of items) summary[i.level]++
  return {
    entry,
    name: opts.name ?? String(original?.flow?.name ?? (ns ? `Fluxo importado ${ns}` : 'Fluxo importado')),
    graph: { nodes: graphNodes, edges: kept, origin: { source: 'manychat', ns, page_id: clip.pageId ?? null } },
    report: { source: { ns, page_id: clip.pageId ?? null }, nodes_in: clip.data.nodesData.length, nodes_out: nodes.length, items, unsupported, media, summary },
  }
}
