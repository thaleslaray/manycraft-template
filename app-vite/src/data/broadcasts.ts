import type { Graph } from "./types"
import { apiRequest } from "./api"
import { variables as templateVariables } from "./message-templates"

export type BroadcastStatus = "draft" | "scheduled" | "sending" | "paused" | "sent" | "cancelled"
export type BroadcastChannel = "telegram" | "instagram" | "whatsapp" | "messenger" | "email" | "tiktok"
export type BroadcastAudienceCondition = "tag" | "segment" | "email"
export type BroadcastAudience = { tag: string; channel: BroadcastChannel; channel_id: string; email_filter?: string; segment_id?:string; /** Condições que a pessoa abriu no público, mesmo as que ainda estão no valor padrão. */ conditions?: BroadcastAudienceCondition[] }
export type BroadcastMessageMetrics = { node_id: string; summary: string; sent: number; delivered: number; read: number; clicked: number }
export type BroadcastMetrics = { messages?: BroadcastMessageMetrics[]; total?: number; sent: number; delivered: number; read: number; failed: number; queued: number; skipped: number; outside_window?: number; uncertain: number; clicked: number; opened?: number; ctr?: number }
export type BroadcastEmail = { senderId?: string; subject: string; preheader?: string; html?: string; onOpen?: { mode: 'once' | 'every'; automationId?: string; actions?: {type:'add_tag'|'remove_tag';tag_id:string}[] }; linkActions?: {url:string;automationId?:string;actions?:{type:'add_tag'|'remove_tag';tag_id:string}[]}[] }
/** "automatic" é o das transmissões antigas: o motor decide por destinatário. */
export type BroadcastWindowKind = "automatic" | "in_window" | "promotional"
export type BroadcastTemplate = { id: string; params: Record<string, string> }
export type BroadcastRecipient = { contact_id: string; name?: string; contact_channel_id?: string; status: string; reason?: string | null }
export type Broadcast = {
  id: string
  copied_graph?: Graph | null
  /** Conteúdo como fluxo (mesmo formato do editor de automação): um passo de texto, ou o mapa montado. */
  flow?: Graph | null
  automation_id?: string | null
  workspace_id: string
  name: string
  content: string
  audience: BroadcastAudience
  status: BroadcastStatus
  scheduled_at: string | null
  scheduled_local: string
  timezone: string
  template?: BroadcastTemplate | null
  window_kind?: BroadcastWindowKind
  email?: BroadcastEmail | null
  metrics: BroadcastMetrics | null
  updated_at: string
  retry_at?: string | null
  pause_reason?: string | null
  /** O motivo escrito pelo provedor quando ele recusou a credencial (`token_refused`). */
  pause_detail?: string
  /** O envio já começou? Uma agendada pausada antes da hora ainda não começou e continua em Agendado. */
  started?: boolean
  /** Envio assíncrono sem progresso há mais de 10 minutos: onde parou. */
  stalled?: { percent: number; since: string } | null
  recipients?: BroadcastRecipient[]
}
export type BroadcastInput = Pick<Broadcast, "name" | "content" | "audience" | "timezone" | "scheduled_local"> & {
  id?: string
  status: "draft" | "scheduled" | "sending"
  template?: BroadcastTemplate
  window_kind?: BroadcastWindowKind
  email?: BroadcastEmail
  flow?: Graph
}
export type BroadcastOptions = {
  channels: { id: string; value: BroadcastChannel; label: string; profile?: { email?: {subjectMaxLength:number}; templates?: unknown; window?: unknown } }[]
  tags: { value: string; label: string }[]
  segments: { id: string; name: string }[]
  templates: { id: string; channel_id: string; name: string; language: string; body: string; header_type: string; header_text: string | null; buttons: string }[]
  timezones: string[]
}

/** Campos que a pessoa preenche para enviar o modelo, com as mesmas chaves e a mesma regra de variável do motor (template-draft):
 * corpo sem prefixo, cabeçalho "header:x", botão de link "button:índice:x". */
export function broadcastTemplateVariables(template: Pick<BroadcastOptions["templates"][number], "body" | "header_type" | "header_text" | "buttons">): { key: string; label: string }[] {
  return [
    ...templateVariables(template.body).map((key) => ({ key, label: `Valor de ${key}` })),
    ...(template.header_type === "text" ? templateVariables(template.header_text ?? "").map((key) => ({ key: `header:${key}`, label: `Cabeçalho: valor de ${key}` })) : []),
    ...(JSON.parse(template.buttons) as { text: string; url?: string }[]).flatMap((button, index) => templateVariables(button.url ?? "").map((key) => ({ key: `button:${index}:${key}`, label: `Botão ${button.text}: valor de ${key}` }))),
  ]
}

function localParts(date: Date, timezone: string) {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date)
  const part = (type: string) => values.find((v) => v.type === type)!.value
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`
}

/** Converte o horário civil do fuso escolhido; não depende do fuso do navegador. */
export function parseBroadcastSchedule(local: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error("Escolha uma data e um horário válidos.")
  const target = Date.parse(`${local}Z`)
  if (!Number.isFinite(target)) throw new Error("Escolha uma data e um horário válidos.")
  let instant = target
  try {
    for (let i = 0; i < 3; i++) {
      instant += target - Date.parse(`${localParts(new Date(instant), timezone)}Z`)
    }
    if (localParts(new Date(instant), timezone) !== local) throw new Error("Horário inexistente")
    return new Date(instant).toISOString()
  } catch {
    throw new Error("O horário não existe nesse fuso. Escolha outro horário ou fuso.")
  }
}

export async function listBroadcasts(_workspaceId: string, options: { status?: BroadcastStatus; search?: string } = {}): Promise<Broadcast[]> {
  const query = new URLSearchParams()
  if (options.status) query.set("status", options.status)
  if (options.search?.trim()) query.set("search", options.search.trim())
  return apiRequest<Broadcast[]>(`/broadcasts${query.size ? `?${query}` : ""}`)
}

export async function getBroadcastOptions(_workspaceId: string): Promise<BroadcastOptions> {
  return apiRequest<BroadcastOptions>("/broadcasts/options")
}

/** Lista de transmissões com as opções da tela, numa leitura só (a tela e o aquecimento do menu usam a mesma). */
export async function loadBroadcastsPage(workspaceId: string): Promise<{ items: Broadcast[]; options: BroadcastOptions }> {
  const [items, options] = await Promise.all([listBroadcasts(workspaceId), getBroadcastOptions(workspaceId)])
  return { items, options }
}

/** O que cada tipo permite no conteúdo e o texto que a tela mostra para explicar. */
export function broadcastWindowRule(kind: BroadcastWindowKind): { text: boolean; template: boolean; note: string } {
  if (kind === "in_window") return { text: true, template: false, note: "Só chega a quem falou com você nas últimas 24 horas. A mensagem é texto livre." }
  if (kind === "promotional") return { text: false, template: true, note: "Chega também a quem não fala com você há mais de 24 horas, mas só com um modelo aprovado: o WhatsApp não aceita texto livre fora da janela." }
  return { text: true, template: true, note: "" }
}
/** O seletor de tipo só aparece em conexão que tem janela de atendimento (não em e-mail nem Telegram). */
export function hasBroadcastWindow(profile: { window?: unknown } | undefined): boolean {
  return !!profile?.window
}

/** Tipo que a transmissão nova já traz: no WhatsApp oficial com modelos aprovados é "Fora da janela / promocional" (como no ManyChat); sem modelos, ou em transmissão existente, continua dentro da janela. Canal sem janela não tem tipo. */
export function defaultBroadcastWindowKind({ windowChannel, canUseTemplates, approvedTemplates, isNew }: { windowChannel: boolean; canUseTemplates: boolean; approvedTemplates: number; isNew: boolean }): BroadcastWindowKind {
  if (!windowChannel) return "automatic"
  return isNew && canUseTemplates && approvedTemplates > 0 ? "promotional" : "in_window"
}

export async function estimateBroadcastAudience(_workspaceId: string, audience: BroadcastAudience, template?: BroadcastTemplate, windowKind: BroadcastWindowKind = "automatic"): Promise<number> {
  if (!audience.channel_id) return 0
  const query = new URLSearchParams({ tag: audience.tag, channel: audience.channel, channel_id: audience.channel_id })
  if (audience.email_filter) query.set('email_filter', audience.email_filter)
  if (audience.segment_id) query.set('segment_id',audience.segment_id)
  const result = await apiRequest<{ count: number; eligible: number }>(`/broadcasts/audience${template || windowKind !== "automatic" ? "" : `?${query}`}`, template || windowKind !== "automatic" ? { method: "POST", body: JSON.stringify({ ...audience, template, window_kind: windowKind }) } : undefined)
  return result.eligible
}

export type AudienceContacts = { total: number; page: number; limit: number; contacts: { id: string; name: string; photo: string | null }[] }

/** Uma página de quem receberia (os mesmos contatos únicos elegíveis da contagem). */
export async function listAudienceContacts(audience: BroadcastAudience, template?: BroadcastTemplate, windowKind: BroadcastWindowKind = "automatic", page = 1, limit = 20): Promise<AudienceContacts> {
  return apiRequest<AudienceContacts>("/broadcasts/audience/contacts", { method: "POST", body: JSON.stringify({ ...audience, template, window_kind: windowKind, page, limit }) })
}

export async function saveBroadcast(_workspaceId: string, input: BroadcastInput): Promise<Broadcast> {
  const scheduledAt = input.status === "scheduled" ? parseBroadcastSchedule(input.scheduled_local, input.timezone) : null
  if (scheduledAt && Date.parse(scheduledAt) <= Date.now()) throw new Error("O agendamento precisa estar no futuro.")
  return apiRequest<Broadcast>("/broadcasts", { method: "POST", body: JSON.stringify({ ...input, scheduled_at: scheduledAt }) })
}

export async function getBroadcast(_workspaceId: string, id: string): Promise<Broadcast> {
  return apiRequest<Broadcast>(`/broadcasts/${encodeURIComponent(id)}`)
}

export async function pauseBroadcast(_workspaceId: string, id: string): Promise<Broadcast> {
  return apiRequest<Broadcast>(`/broadcasts/${encodeURIComponent(id)}/pause`, { method: "POST" })
}

export async function resumeBroadcast(_workspaceId: string, id: string): Promise<Broadcast> {
  return apiRequest<Broadcast>(`/broadcasts/${encodeURIComponent(id)}/resume`, { method: "POST" })
}

const recipientLabels: Record<string, string> = {
  queued: "Na fila", sending: "Em envio", sent: "Enviada", delivered: "Entrega confirmada",
  read: "Leitura confirmada", failed: "Falha no envio", skipped: "Sem elegibilidade",
  uncertain: "Aguardando confirmação",
}
const reasonLabels: Record<string, string> = {
  manual: "Envio pausado por uma pessoa da equipe.",
  rate_limited: "O canal atingiu o limite de envios. Aguarde antes de retomar.",
  channel_or_template_unavailable: "O canal ou o modelo está indisponível. Revise a conexão e o modelo selecionado.",
  channel_not_configured: "O canal precisa ser configurado antes de enviar.",
  connection_unavailable: "A conexão está fora do ar ou o provedor recusou a credencial. Conserte em Canais (Atualizar conexão ou Trocar credencial) e retome o envio.",
  connection_restricted: "O número está restrito para iniciar conversas: só responde a quem escreveu nas últimas 24 horas. O envio está pausado e ninguém foi descartado; quando a restrição acabar, use Atualizar conexão em Canais e retome.",
  outside_window: "Fora da janela de atendimento de 24 h: o contato não escreveu nas últimas 24 horas, então a mensagem não foi enviada. Quando ele escrever de novo, entra nas próximas transmissões. No WhatsApp, um modelo aprovado alcança esses contatos.",
  not_opted_in: "O contato não autorizou o recebimento de mensagens.",
  marketing_opt_out: "O contato pediu para não receber marketing neste número. Ele foi pulado; quando voltar a aceitar, receberá as próximas.",
  blocked: "O contato ou o canal bloqueou o recebimento.",
  uncertain: "O canal ainda não confirmou o envio. Aguarde a confirmação antes de reenviar.",
  unsupported: "Este canal não oferece o recurso solicitado.",
  rejected: "O canal recusou o envio; revise a conexão.",
  token_refused: "O provedor recusou a credencial da conexão. Use Trocar credencial em Canais e retome o envio.",
  window_message_cap: "O contato atingiu o limite de mensagens da janela de atendimento.",
  comment_reply_used: "Este comentário já recebeu a resposta permitida pelo canal.",
  comment_too_old: "O prazo para responder a este comentário terminou.",
  '130429': "O WhatsApp atingiu o limite de envios. Aguarde antes de retomar.",
  '131056': "O contato atingiu o limite de mensagens em sequência. Aguarde antes de retomar.",
  '131049': "O WhatsApp limitou mensagens de marketing para este contato. Aguarde pelo menos 24 horas.",
  '131050': "O contato cancelou o recebimento de mensagens de marketing.",
  '131047': "A janela de atendimento do WhatsApp terminou. Use um modelo aprovado.",
  '131026': "O WhatsApp não conseguiu entregar a mensagem a este contato. Confira o número.",
  '131063': "O envio de marketing pela API de nuvem está desativado nesta conta. Aceite os termos da API de Mensagens de Marketing em Canais, ou reative o envio, antes de retomar.",
  '131055': "A API de Mensagens de Marketing só aceita modelos de marketing. Atualize os modelos antes de retomar.",
  '134100': "A API de Mensagens de Marketing só aceita modelos de marketing; a Meta pode ter reclassificado o modelo. Atualize os modelos antes de retomar.",
  '134101': "A Meta ainda sincroniza este modelo de marketing (até 10 minutos). Espere e retome.",
  '134102': "A conta não está habilitada para a API de Mensagens de Marketing. Confira em Canais antes de retomar.",
  '131061': "A API de nuvem não aceita modelos com preço máximo. Use a API de Mensagens de Marketing, em Canais, antes de retomar.",
  '131062': "A Meta não aceita este modelo para contatos identificados só por identificador de usuário; o contato foi pulado.",
  '131064': "O WhatsApp limitou os envios do número por categoria de modelo. Revise os modelos antes de retomar.",
  '131065': "O país deste contato não aceita preço máximo; o modelo não foi enviado.",
  '131070': "Outro app pode estar controlando a conversa deste contato (Conversation routing).",
  '131048': "O WhatsApp restringiu envios por sinais de mensagens indesejadas. Revise a conta.",
  '131031': "A conta do WhatsApp está restrita. Revise a situação no provedor.",
  '131042': "O WhatsApp bloqueou o envio por um problema de pagamento.",
  '131051': "O WhatsApp não aceita este tipo de mensagem.",
  '131053': "O WhatsApp recusou o arquivo da mensagem. Revise o conteúdo.",
  '131000': "O WhatsApp não confirmou o envio. Aguarde a confirmação antes de reenviar.",
  '132000': "Os valores informados não correspondem às variáveis do modelo.",
  '132001': "O modelo não foi encontrado no idioma selecionado.",
  '132012': "Os valores informados têm formato incompatível com o modelo.",
  '132015': "O WhatsApp pausou este modelo por qualidade. Escolha outro modelo aprovado.",
  '132016': "O WhatsApp desativou este modelo. Escolha outro modelo aprovado.",
  '132018': "O WhatsApp recusou os parâmetros do modelo. Revise os valores informados.",
  '133010': "O número do WhatsApp precisa ser registrado ou reconectado.",
  '135000': "O WhatsApp adiou a avaliação desta mensagem. Aguarde antes de tentar novamente.",
  '368': "A Meta restringiu temporariamente os envios deste canal. Revise a conta.",
  '80007': "A Meta atingiu o limite de solicitações deste canal. Aguarde antes de retomar.",
}
export function broadcastRecipientStatusLabel(status: string): string {
  return recipientLabels[status] ?? "Situação indisponível"
}
/** `detail` é o motivo que o provedor deu quando recusou a credencial (`token_refused`); vale mais que o texto genérico. */
export function broadcastReasonLabel(reason: string, detail?: string): string {
  if (reason === "token_refused" && detail) return detail
  return reasonLabels[reason] ?? "O canal recusou o envio; revise a conexão."
}

export async function createBroadcastFromAutomation(automation_id: string, channel_id: string): Promise<Broadcast> {
  return apiRequest("/broadcasts/from-automation", { method: "POST", body: JSON.stringify({ automation_id, channel_id }) })
}
export async function deleteBroadcast(id: string): Promise<void> {
  await apiRequest(`/broadcasts/${encodeURIComponent(id)}`, { method: "DELETE" })
}
export async function cancelBroadcast(id: string): Promise<Broadcast> {
  return apiRequest(`/broadcasts/${encodeURIComponent(id)}/cancel`, { method: "POST" })
}
export async function testBroadcast(id: string, contact_id: string): Promise<unknown> {
  return apiRequest(`/broadcasts/${encodeURIComponent(id)}/test`, { method: "POST", body: JSON.stringify({ contact_id }) })
}
