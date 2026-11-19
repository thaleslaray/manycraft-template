import { messageVariables } from "../../../../engine/src/schemas/message-variables"
import { questionSystemField } from "../../../../engine/src/schemas/question"
import type { ButtonAction } from "../../../../engine/src/schemas/graph"
import type { CardsBlock } from "../../../../engine/src/schemas/message-cards"
import type { MediaBlock } from "../../../../engine/src/schemas/message-media"
import type { Graph, GraphNode } from "@/data/types"

/** Prévia da automação: percorre o grafo como o contato veria, sem executar nada (não envia, não grava, não chama requisição). */

export type PreviewCatalog = {
  tags: { id: string; name: string }[]
  fields: { id: string; name: string; type?: string }[]
  sequences: { id: string; name: string }[]
  automations: { id: string; name: string }[]
}
export type PreviewEnv = { graph: Graph; catalog: PreviewCatalog }

export type PreviewItem = { id: number } & (
  | { kind: "text"; text: string }
  | { kind: "contact"; text: string }
  | { kind: "note"; text: string }
  | { kind: "media"; block: MediaBlock }
  | { kind: "cards"; block: CardsBlock }
)
export type PreviewChoice = {
  id: string
  label: string
  /** button/reply/skip: o contato toca; link: abriria um site; path: caminho escolhido por quem testa; timeout: ninguém responde. */
  tone: "button" | "reply" | "skip" | "link" | "path" | "timeout"
  port: string
  url?: string
  actions?: ButtonAction[]
}
export type PreviewWait =
  | { kind: "choices"; node: string; choices: PreviewChoice[] }
  | { kind: "answer"; node: string; answerType: string; options: string[]; skip: boolean; attempts: number; maxAttempts: number }
export type PreviewState = {
  items: PreviewItem[]
  wait: PreviewWait | null
  /** Por que a prévia parou (fim do fluxo, limite, exclusão do contato). */
  ended: string | null
  /** Valores guardados só na prévia, para as variáveis seguintes. */
  values: Record<string, string>
  tags: string[]
  steps: number
}

export const NONE_CHOICE = "__none"
export const SKIP_CHOICE = "__skip"
export const TIMEOUT_CHOICE = "__timeout"
const STEP_LIMIT = 200
const SAMPLE_FIRST = "Maria"
const SAMPLE_LAST = "Silva"

const unitName: Record<string, [string, string]> = { seconds: ["segundo", "segundos"], minutes: ["minuto", "minutos"], hours: ["hora", "horas"], days: ["dia", "dias"] }
function durationText(value: unknown): string | null {
  const d = value as { value?: number; unit?: string } | undefined
  const names = d?.unit ? unitName[d.unit] : undefined
  return d && names && typeof d.value === "number" ? `${d.value} ${d.value === 1 ? names[0] : names[1]}` : null
}

const actionNotes: Record<string, string> = {
  remove_from_sequence: "Aqui o contato seria tirado de uma sequência.",
  subscribe_topic: "Aqui o contato seria inscrito no tópico de notificação.",
  unsubscribe_topic: "Aqui o contato sairia do tópico de notificação.",
  assign_conversation: "Aqui a conversa seria atribuída à equipe.",
  open_conversation: "Aqui a conversa seria aberta.",
  close_conversation: "Aqui a conversa seria fechada.",
  notify_admin: "Aqui a equipe seria notificada.",
  pause_automations: "Aqui as automações do contato seriam pausadas.",
  subscribe_to_account: "Aqui o contato seria inscrito na conexão.",
  unsubscribe_to_account: "Aqui a inscrição do contato na conexão seria cancelada.",
  fire_custom_event: "Aqui uma conversão seria registrada.",
}

export function startPreview(env: PreviewEnv): PreviewState {
  const s = fresh()
  const trigger = env.graph.nodes.find(n => n.type === "trigger")
  if (!trigger) return { ...s, ended: "Esta automação ainda não tem gatilho." }
  run(env, s, follow(env, s, trigger.id, "next"))
  return s
}

export function choosePreview(env: PreviewEnv, state: PreviewState, choiceId: string): PreviewState {
  const wait = state.wait
  if (!wait) return state
  const s = clone(state)
  if (wait.kind === "answer") {
    s.wait = null
    if (choiceId === SKIP_CHOICE) {
      push(s, { kind: "contact", text: "Pular" }); push(s, { kind: "note", text: "Pergunta pulada: nada seria guardado." })
      run(env, s, follow(env, s, wait.node, "success"))
    } else {
      push(s, { kind: "note", text: "Tempo esgotado: o contato não respondeu." })
      run(env, s, follow(env, s, wait.node, "no_response"))
    }
    return s
  }
  const choice = wait.choices.find(c => c.id === choiceId)
  if (!choice) return state
  s.wait = null
  if (choice.tone === "timeout") push(s, { kind: "note", text: "O contato não tocou em nada." })
  else if (choice.tone === "path") push(s, { kind: "note", text: `Caminho escolhido: ${choice.label}.` })
  else push(s, { kind: "contact", text: choice.label })
  if (choice.tone === "link") push(s, { kind: "note", text: `O contato abriria o link ${choice.url ?? ""}.`.replace(" .", ".") })
  if (choice.actions?.length) runActions(env, s, choice.actions)
  run(env, s, followAny(env, s, wait.node, exitsOf(choice)))
  return s
}

export function answerPreview(env: PreviewEnv, state: PreviewState, text: string): PreviewState {
  const wait = state.wait
  const typed = text.trim()
  if (wait?.kind !== "answer" || !typed) return state
  const node = env.graph.nodes.find(n => n.id === wait.node)
  if (!node) return state
  const s = clone(state)
  s.wait = null
  push(s, { kind: "contact", text: typed })
  const checked = validAnswer(wait.answerType, typed, wait.options)
  if (checked.ok) {
    const fieldId = String(node.config.field_id ?? "")
    const name = fieldName(env, fieldId)
    s.values[fieldId] = checked.value
    push(s, { kind: "note", text: `Aqui o campo “${name}” receberia “${checked.value}”. Na prévia nada é gravado.` })
    run(env, s, follow(env, s, node.id, "success"))
    return s
  }
  const attempts = wait.attempts + 1
  if (attempts >= wait.maxAttempts) {
    push(s, { kind: "note", text: "Limite de tentativas: segue pelo caminho Sem resposta." })
    run(env, s, follow(env, s, node.id, "no_response"))
    return s
  }
  push(s, { kind: "text", text: render(s, String(node.config.retry_message ?? "")) })
  s.wait = { ...wait, attempts }
  return s
}

// ───────── interno ─────────

function fresh(): PreviewState { return { items: [], wait: null, ended: null, values: {}, tags: [], steps: 0 } }
function clone(state: PreviewState): PreviewState {
  return { ...state, items: [...state.items], values: { ...state.values }, tags: [...state.tags] }
}
function push(s: PreviewState, item: DistributiveOmit<PreviewItem, "id">) {
  s.items.push({ ...item, id: s.items.length } as PreviewItem)
}
type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never

const hasEdge = (env: PreviewEnv, from: string, port: string) => env.graph.edges.some(e => e.from === from && (e.port === port || (port === "next" && e.port === "then")))
function follow(env: PreviewEnv, s: PreviewState, from: string, port: string): string | null {
  const edge = env.graph.edges.find(e => e.from === from && (e.port === port || (port === "next" && e.port === "then")))
  if (edge) return edge.to
  if (!s.ended) s.ended = "O fluxo termina aqui: este caminho não tem próximo passo."
  return null
}

/** Saídas que o motor tenta, em ordem: a do botão (btn:<id> ou só <id>) e, no Pular sem saída própria, o próximo passo. */
function exitsOf(choice: PreviewChoice): string[] {
  if (choice.tone === "button" || choice.tone === "reply" || choice.tone === "skip" || choice.tone === "link") {
    const bare = choice.port.replace(/^btn:/, "")
    return [choice.port, ...(bare !== choice.port ? [bare] : []), ...(choice.tone === "skip" ? ["next"] : [])]
  }
  return [choice.port]
}
function followAny(env: PreviewEnv, s: PreviewState, from: string, ports: string[]): string | null {
  return follow(env, s, from, ports.find(port => hasEdge(env, from, port)) ?? ports[0])
}

function fieldName(env: PreviewEnv, fieldId: string): string {
  return questionSystemField(fieldId)?.label ?? env.catalog.fields.find(f => f.id === fieldId)?.name ?? "campo sem nome"
}

function render(s: PreviewState, text: string): string {
  let out = text
  for (const v of messageVariables(text)) {
    let value: string | undefined
    if (v.field === "primeiro_nome") value = s.values["system:first_name"] ?? SAMPLE_FIRST
    else if (v.field === "sobrenome") value = s.values["system:last_name"] ?? SAMPLE_LAST
    else if (v.field.startsWith("campo:")) value = s.values[v.field.slice(6)]
    else if (v.field.startsWith("anuncio_")) value = v.fallback || "Anúncio de exemplo"
    else if (v.field === "nome_da_pagina") value = "Sua página"
    else if (v.field === "nome_completo") value = `${s.values["system:first_name"] ?? SAMPLE_FIRST} ${s.values["system:last_name"] ?? SAMPLE_LAST}`
    else if (v.field === "email") value = s.values["system:email"] ?? "contato@exemplo.com"
    else if (v.field === "telefone") value = s.values["system:phone"] ?? "+55 11 98765-4321"
    const shown = value?.trim() ? value : v.fallback
    out = out.replace(v.raw, () => shown)
  }
  return out
}

function validAnswer(type: string, text: string, options: string[]): { ok: true; value: string } | { ok: false } {
  const yes = (value = text) => ({ ok: true as const, value })
  if (type === "multiple_choice") { const hit = options.find(o => o.toLowerCase() === text.toLowerCase()); return hit ? yes(hit) : { ok: false } }
  if (type === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? yes() : { ok: false }
  if (type === "phone") return text.replace(/\D/g, "").length >= 8 && /^\+?[\d\s()-]+$/.test(text) ? yes() : { ok: false }
  if (type === "number") { const n = Number(text.replace(",", ".")); return text !== "" && Number.isFinite(n) ? yes(String(n)) : { ok: false } }
  if (type === "url") return /^https?:\/\/\S+\.\S+$/i.test(text) ? yes() : { ok: false }
  if (type === "date") return /^(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})$/.test(text) ? yes() : { ok: false }
  if (type === "datetime") return /^(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})[ T]\d{1,2}[:h]\d{2}/.test(text) ? yes() : { ok: false }
  return yes()
}

function run(env: PreviewEnv, s: PreviewState, start: string | null) {
  let current = start
  while (current && !s.wait) {
    if (++s.steps > STEP_LIMIT) { s.ended = "A prévia parou no limite de passos: o fluxo parece voltar para si mesmo."; return }
    const node = env.graph.nodes.find(n => n.id === current)
    if (!node) { s.ended = "O fluxo termina aqui: o próximo passo não existe mais."; return }
    current = visit(env, s, node)
  }
  if (!current && !s.wait && !s.ended) s.ended = "O fluxo termina aqui."
  if (s.wait) s.ended = null
}

/** Executa um passo na prévia; devolve o próximo passo ou null (fim ou espera). */
function visit(env: PreviewEnv, s: PreviewState, node: GraphNode): string | null {
  const config = node.config
  if (node.type === "message") return visitMessage(env, s, node)
  if (node.type === "question") {
    push(s, { kind: "text", text: render(s, String(config.text ?? "")) })
    const answerType = String(config.answer_type ?? "text")
    s.wait = { kind: "answer", node: node.id, answerType, options: answerType === "multiple_choice" ? (config.choices as string[] | undefined) ?? [] : [],
      skip: config.skip === true, attempts: 0, maxAttempts: Number(config.max_attempts) || 3 }
    return null
  }
  if (node.type === "action" || (node.type as string) === "action_group") {
    const stop = runActions(env, s, (config.actions as Record<string, unknown>[] | undefined) ?? [])
    return stop ? null : follow(env, s, node.id, "next")
  }
  if ((node.type as string) === "dynamic") {
    push(s, { kind: "note", text: "Bloco dinâmico: o conteúdo vem do seu servidor e não aparece na prévia." })
    return follow(env, s, node.id, "next")
  }
  if (node.type === "smart_delay") {
    const time = durationText(config.duration)
    push(s, { kind: "note", text: time ? `Espera de ${time} pulada na prévia.` : "Espera pulada na prévia." })
    return follow(env, s, node.id, "next")
  }
  if (node.type === "condition") {
    push(s, { kind: "note", text: "Verificar condição: escolha por qual caminho o contato seguiria." })
    s.wait = { kind: "choices", node: node.id, choices: [{ id: "true", label: "Se atender às regras", tone: "path", port: "true" }, { id: "false", label: "Se não atender às regras", tone: "path", port: "false" }] }
    return null
  }
  if (node.type === "randomizer" || (node.type as string) === "split") {
    const variations = (config.variations as { id: string }[] | undefined) ?? []
    push(s, { kind: "note", text: "Dividir caminhos: escolha por qual caminho o contato seguiria." })
    s.wait = { kind: "choices", node: node.id, choices: variations.map((v, i) => ({ id: v.id, label: `Caminho ${i + 1}`, tone: "path" as const, port: v.id })) }
    return variations.length ? null : follow(env, s, node.id, "next")
  }
  if (node.type === "start_automation") {
    const target = env.catalog.automations.find(a => a.id === config.automation_id)?.name
    const name = target ? `“${target}”` : "escolhida"
    push(s, { kind: "note", text: config.wait_for_finish === true
      ? `Aqui a automação ${name} começaria e este fluxo esperaria ela terminar para seguir. A prévia não a executa e segue por este fluxo.`
      : `Aqui a automação ${name} começaria em paralelo e este fluxo seguiria sem esperar. A prévia segue por este fluxo.` })
    return follow(env, s, node.id, "next")
  }
  push(s, { kind: "note", text: "Este tipo de passo não é simulado na prévia." })
  return follow(env, s, node.id, "next")
}

function visitMessage(env: PreviewEnv, s: PreviewState, node: GraphNode): string | null {
  const config = node.config
  const choices: PreviewChoice[] = []
  const email = config.email as { subject?: string } | undefined
  if (email) push(s, { kind: "note", text: `E-mail com o assunto “${render(s, email.subject ?? "")}”: a prévia não mostra o corpo.` })
  for (const [index, block] of ((config.blocks as Record<string, unknown>[] | undefined) ?? []).entries()) {
    const kind = block.kind
    if (kind === "text") { const text = render(s, String(block.text ?? "")); if (text.trim()) push(s, { kind: "text", text }) }
    else if (kind === "media") push(s, { kind: "media", block: { ...(block as MediaBlock), url: render(s, String((block as MediaBlock).url ?? "")) } })
    else if (kind === "card" || kind === "gallery") {
      const cards = block as unknown as CardsBlock
      const shown: CardsBlock = { ...cards, cards: cards.cards.map(c => ({ ...c, title: render(s, c.title), ...(c.subtitle ? { subtitle: render(s, c.subtitle) } : {}), buttons: c.buttons?.map(b => ({ ...b, title: render(s, b.title) })) })) }
      push(s, { kind: "cards", block: shown })
      shown.cards.forEach((card, ci) => card.buttons?.forEach((b, bi) => {
        if (b.type === "postback") choices.push({ id: `card:${index}:${ci}:${bi}`, label: b.title, tone: "button", port: "next" })
      }))
    } else if (kind === "button") {
      const link = (block.action as { type?: string; url?: string } | undefined)
      // Como no motor, botão de link sem saída ligada só mostra o endereço: não espera toque nenhum.
      if (link?.type === "url" && !hasEdge(env, node.id, `btn:${block.id}`) && !hasEdge(env, node.id, String(block.id))) {
        push(s, { kind: "note", text: `O botão “${render(s, String(block.label ?? ""))}” abriria ${link.url ?? "o link"}; sem saída ligada, o fluxo não espera o toque.` })
        continue
      }
      choices.push({ id: `btn:${block.id}`, label: render(s, String(block.label ?? "")), tone: link?.type === "url" ? "link" : "button", port: `btn:${block.id}`,
        ...(link?.type === "url" ? { url: link.url } : {}), ...(Array.isArray(block.actions) && block.actions.length ? { actions: block.actions as ButtonAction[] } : {}) })
    } else if (kind === "list") {
      // Cada opção da lista é um toque como o de um botão: segue pela saída da opção e, sem toque, pela saída "Sem resposta".
      const rows = Array.isArray(block.sections) ? (block.sections as { rows?: { id: string; title?: string }[] }[]).flatMap(section => section.rows ?? []) : []
      for (const row of rows) choices.push({ id: `btn:${row.id}`, label: render(s, String(row.title ?? "")), tone: "button", port: `btn:${row.id}` })
    } else if (kind === "quick_reply") {
      choices.push({ id: `btn:${block.id}`, label: block.skip ? "Pular" : render(s, String(block.label ?? "")), tone: block.skip ? "skip" : "reply", port: `btn:${block.id}` })
    }
  }
  if (!choices.length) return follow(env, s, node.id, "next")
  // Sem toque: resposta rápida segue pelo próximo passo; botões seguem só pela saída "Sem resposta" (timeout) e param se ela não existir.
  const quick = choices.some(c => c.tone === "reply" || c.tone === "skip")
  s.wait = { kind: "choices", node: node.id, choices: [...choices, { id: NONE_CHOICE, label: "Não tocar em nada", tone: "timeout", port: quick ? "next" : "timeout" }] }
  return null
}

/** Devolve true quando a prévia deve parar (contato excluído). Nada é gravado: só notas e valores locais. */
function runActions(env: PreviewEnv, s: PreviewState, actions: Record<string, unknown>[]): boolean {
  for (const a of actions) {
    const type = String(a.type)
    if (type === "delete_subscriber") {
      push(s, { kind: "note", text: "Aqui o contato seria excluído e a execução terminaria. A prévia para neste ponto." })
      s.ended = "A prévia parou: o contato seria excluído neste passo."
      return true
    }
    const tag = env.catalog.tags.find(t => t.id === a.tag_id)?.name ?? "sem nome"
    if (type === "add_tag") { push(s, { kind: "note", text: `Aqui a etiqueta “${tag}” seria adicionada.` }); s.tags.push(String(a.tag_id)) }
    else if (type === "remove_tag") { push(s, { kind: "note", text: `Aqui a etiqueta “${tag}” seria removida.` }); s.tags = s.tags.filter(t => t !== a.tag_id) }
    else if (type === "add_to_sequence") push(s, { kind: "note", text: `Aqui o contato seria inscrito na sequência “${env.catalog.sequences.find(q => q.id === a.sequence_id)?.name ?? "sem nome"}”.` })
    else if (type === "set_custom_field_value" || type === "unset_custom_field_value") {
      const name = fieldName(env, String(a.field_id))
      const operation = type === "unset_custom_field_value" ? "clear" : String(a.operation ?? "set")
      if (operation === "clear") { delete s.values[String(a.field_id)]; push(s, { kind: "note", text: `Aqui o campo “${name}” seria limpo.` }) }
      else if (operation === "set") {
        const value = render(s, typeof a.value === "string" ? a.value : JSON.stringify(a.value) ?? "")
        s.values[String(a.field_id)] = value
        push(s, { kind: "note", text: `Aqui o campo “${name}” receberia “${value}”.` })
      } else push(s, { kind: "note", text: `Aqui o campo “${name}” seria alterado (${operation === "add" ? "soma" : operation === "subtract" ? "subtração" : operation === "add_days" ? "soma de dias" : "data de agora"}).` })
    } else if (type === "external_request") {
      const url = String(a.url ?? "").replace(/^https?:\/\//, "").replace(/[?#].*$/, "")
      push(s, { kind: "note", text: `Aqui seria chamada a requisição externa ${String(a.method ?? "GET")} ${url || "(endereço a definir)"}. Na prévia ela não é chamada.` })
    } else if (type.startsWith("set_") && /_opt_(in|out)$/.test(type)) push(s, { kind: "note", text: `Aqui a inscrição de marketing do contato mudaria (${type.endsWith("opt_in") ? "inscrever" : "cancelar"}).` })
    else push(s, { kind: "note", text: actionNotes[type] ?? "Aqui uma ação seria executada." })
  }
  return false
}
