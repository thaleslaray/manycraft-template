/**
 * Identidade de cache (`useAsync(..., { cache })`) e filtro de abertura das telas do menu.
 * A tela e o aquecimento do menu (lib/prefetch-data) usam as mesmas funções: identidade diferente é pedido jogado fora.
 * Módulo sem dependência em tempo de execução, para não arrastar o código das telas para a carga inicial.
 */
import type { ContactFilter, Trigger } from "./types"
import type { LibraryFilter } from "./index"
import type { InboxFilter, InboxFolder, InboxChannel } from "./inbox"
import type { ReportChannel } from "./dashboard"
import type { InsightsChannel, InsightsPeriod } from "./insights"
import type { ContactQueryFilter } from "./segments"
import type { SettingsPart } from "./settings"

export const dashboardDefaults = { period: 7, channel: "all" as ReportChannel }
export const dashboardKey = (ws: string, period: number, channel: ReportChannel) => `dashboard|${ws}|${period}|${channel}`
export const onboardingConnectionsKey = (ws: string) => `onboarding-connections|${ws}`
export const inicioModelosKey = (ws: string) => `inicio-modelos|${ws}`

export const contactsKeys = {
  segments: (ws: string) => `contacts-segments|${ws}`,
  tags: (ws: string) => `contacts-tags|${ws}`,
  facets: (ws: string) => `contacts-facets|${ws}`,
  fields: (ws: string) => `contacts-fields|${ws}`,
}
type EmailFilters = Pick<ContactFilter, "email_filter" | "contact_filter" | "segment_id">
/** Lista de contatos: `advanced` é o filtro avançado (vazio na abertura); `tagId` a escolha da lateral. */
export const contactsListKey = (ws: string, o: { tagId: string | null; q: string; advanced: ContactQueryFilter; emailFilters: EmailFilters; onlySubscribed: boolean }) =>
  `contacts|${ws}|${o.tagId}|${o.q}|${JSON.stringify(o.advanced)}|${JSON.stringify(o.emailFilters)}|${o.onlySubscribed}`
/** A lateral escolhe uma tag, um gatilho ("trigger:id") ou uma sequência ("sequence:id"). */
export function contactsListFilter(tagId: string | null, q: string, emailFilters: EmailFilters, onlySubscribed: boolean): ContactFilter {
  const facet = tagId?.startsWith("trigger:") ? { trigger_id: tagId.slice(8) } : tagId?.startsWith("sequence:") ? { sequence_id: tagId.slice(9) } : tagId ? { tag_id: tagId } : {}
  return { ...facet, search: q, ...emailFilters, ...(onlySubscribed ? { status: "subscribed" as const } : {}) }
}

export const automationFoldersKey = (ws: string) => `automation-folders|${ws}`
/**
 * Filtro da lista de automações a partir do endereço (pasta, lixeira, busca, filtros). Sem nada no endereço é a raiz:
 * só as automações soltas (`folder_id: null`). O layout (cartões ou lista) não entra: não muda o pedido.
 */
export function automationLibraryFilter(params: URLSearchParams): LibraryFilter {
  const folder = params.get("folder") ?? "all", trash = params.get("view") === "trash", showAll = params.get("view") === "all"
  const filtering = ["search", "status", "trigger_type", "trigger_status"].some(k => params.get(k))
  return {
    folder_id: trash || (folder === "all" && (filtering || showAll)) ? undefined : folder === "all" || folder === "none" ? null : folder,
    trash, search: params.get("search") || undefined,
    status: (params.get("status") || undefined) as LibraryFilter["status"],
    trigger_type: (params.get("trigger_type") || undefined) as Trigger["type"] | undefined,
    trigger_status: params.get("trigger_status") || undefined,
  }
}
/** Só a primeira página entra no cache ("carregar mais" continua pedindo pelo cursor). */
export const automationLibraryKey = (ws: string, filter: LibraryFilter) => `automation-library|${ws}|${JSON.stringify(filter)}`

export type InboxListState = { folder: InboxFolder; status: "all" | "open" | "closed"; channel: InboxChannel | "all" | `conn:${string}`; unread: boolean; sort: "newest" | "oldest"; search: string; labelId: string; contactFilter?: ContactQueryFilter }
export const inboxDefaults: InboxListState = { folder: "all", status: "open", channel: "all", unread: false, sort: "newest", search: "", labelId: "all" }
export function inboxListFilter(s: InboxListState): InboxFilter {
  return { folder: s.folder, status: s.status, channel: s.channel, unread: s.unread, sort: s.sort, search: s.search, ...(s.labelId !== "all" ? { label_id: s.labelId } : {}), ...(s.contactFilter?.rules.length ? { contact_filter: s.contactFilter } : {}) }
}
export const inboxListKey = (ws: string, filter: InboxFilter) => `inbox-list|${ws}|${JSON.stringify(filter)}`
export const inboxLabelsKey = (ws: string) => `inbox-labels|${ws}`
export const inboxMentionsKey = (ws: string) => `inbox-mentions|${ws}`

export const broadcastsKey = (ws: string) => `broadcasts|${ws}`

export const insightsDefaults = { period: 7 as InsightsPeriod, channel: "all" as InsightsChannel }
export const insightsKey = (ws: string, period: InsightsPeriod, channel: InsightsChannel) => `insights|${ws}|${period}|${channel}`
export const insightsInboxKey = (ws: string, period: InsightsPeriod) => `insights-inbox|${ws}|${period}`

/** O que cada seção em formulário único (Geral, Campos, Tags, API) pede ao abrir: a tela e o aquecimento usam a mesma lista. */
export function settingsParts(section: "general" | "fields" | "tags" | "api"): SettingsPart[] {
  return section === "general" ? ["general"] : section === "fields" ? ["fields", "fieldFolders"] : section === "tags" ? ["tags", "tagFolders"] : ["api"]
}

/** Configurações: uma identidade por aba (o que a aba mostra ao abrir). Abas com segredo guardam só o que não é segredo. */
export const settingsKeys = {
  general: (ws: string) => `settings-general|${ws}`,
  fields: (ws: string) => `settings-fields|${ws}`,
  tags: (ws: string) => `settings-tags|${ws}`,
  /** Só o final e a data da chave; o valor completo aparece uma vez na geração e fica no estado da tela. */
  api: (ws: string) => `settings-api|${ws}`,
  profileApiKey: (ws: string) => `profile-api-key|${ws}`,
  memberAlerts: (ws: string) => `member-alerts|${ws}`,
  noticePrefs: (ws: string) => `notice-prefs|${ws}`,
  team: (ws: string) => `team|${ws}`,
  logs: (ws: string, errors: boolean, kind: string, level: string) => `logs-settings|${ws}|${errors}|${kind}|${level}`,
  logsTotals: (ws: string) => `logs-settings-totais|${ws}`,
  compliance: (ws: string) => `compliance|${ws}`,
  inbox: (ws: string) => `inbox-settings|${ws}`,
  inboxLabels: (ws: string) => `inbox-labels-settings|${ws}`,
  assignment: (ws: string) => `inbox-assignment|${ws}`,
  email: (ws: string) => `email-settings|${ws}`,
  emailMetrics: (ws: string) => `email-metrics|${ws}`,
  marketingProvider: (ws: string) => `email-marketing-provider|${ws}`,
  emailStopOptions: (ws: string) => `email-stop-options|${ws}`,
  emailStop: (ws: string, connection: string) => `email-stop|${ws}|${connection}`,
  topics: (ws: string) => `notification-topics|${ws}`,
  sheets: (ws: string) => `integrations-sheets|${ws}`,
  pixel: (ws: string) => `integrations-pixel|${ws}`,
  apps: (ws: string) => `settings-apps|${ws}`,
  installed: (ws: string) => `installed-templates|${ws}`,
}

/**
 * Gravações (qualquer método que não GET) e as identidades de cache que elas deixam velhas, por prefixo.
 * data/api descarta esses caches quando a gravação dá certo, antes de a tela recarregar; assim vale para toda tela e diálogo
 * que grava, sem lembrar disso em cada componente.
 */
const staleAfter: [RegExp, string[]][] = [
  // Linhas da biblioteca mostram nome, estado, pasta, gatilho e "alterações não publicadas": o editor, os gatilhos, as palavras-chave, os modelos e as respostas básicas mexem nelas.
  [/^\/(automations|folders|keywords|triggers|quick-automations|automation-templates|basic|imports)(\/|\?|$)/, ["automation-library|", "email-stop-options|"]],
  [/^\/automation-templates(\/|\?|$)/, ["installed-templates|"]],
  [/^\/workspace-settings(\/|\?|$)/, ["settings-general|"]],
  [/^\/(fields|settings-folders|imports)(\/|\?|$)/, ["settings-fields|"]],
  [/^\/(tags|settings-folders|imports)(\/|\?|$)/, ["settings-tags|"]],
  [/^\/api-keys(\/|\?|$)/, ["settings-api|"]],
  [/^\/profile\/api-keys?(\/|\?|$)/, ["profile-api-key|"]],
  [/^\/me\/alerts(\/|\?|$)/, ["member-alerts|"]],
  [/^\/notices\/preferences(\/|\?|$)/, ["notice-prefs|"]],
  [/^\/(team|invites|access-requests)(\/|\?|$)/, ["team|"]],
  [/^\/inbox\/(settings|saved-replies)(\/|\?|$)/, ["inbox-settings|"]],
  [/^\/inbox\/labels(\/|\?|$)/, ["inbox-labels-settings|", "inbox-labels|"]],
  [/^\/inbox\/(assignment|assignment-rules|groups)(\/|\?|$)/, ["inbox-assignment|"]],
  [/^\/email(\/|\?|$)/, ["email-settings|", "email-marketing-provider|", "email-stop|"]],
  [/^\/connections(\/|\?|$)/, ["email-stop-options|", "topic-connections|"]],
  [/^\/notification-topics(\/|\?|$)/, ["notification-topics|"]],
  [/^\/integrations\/google-sheets(\/|\?|$)/, ["integrations-sheets|"]],
  [/^\/pixel(\/|\?|$)/, ["integrations-pixel|"]],
  [/^\/apps(\/|\?|$)/, ["settings-apps|"]],
  [/^\/message-templates(\/|\?|$)/, ["message-templates|"]],
]
export function staleAfterWrite(method: string, path: string): string[] {
  if (method.toUpperCase() === "GET") return []
  return [...new Set(staleAfter.filter(([pattern]) => pattern.test(path)).flatMap(([, prefixes]) => prefixes))]
}
