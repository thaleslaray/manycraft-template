/**
 * Aquece o DADO das telas do menu (o código já vem de prefetch.ts): passar o mouse, focar ou tocar no item
 * grava a resposta no cache do useAsync, e a tela abre preenchida em vez de esqueleto.
 * As identidades e filtros de abertura vêm de data/screen-keys, os mesmos que cada tela usa.
 * As funções de dados chegam por import dinâmico: este módulo fica na carga inicial e não pode arrastar as telas.
 */
import type { Action } from "../../../shared/permissions"
import { isFakeMode } from "@/data/api"
import { primeAsync } from "@/hooks/use-async"
import { automationAreas } from "@/lib/nav"
import * as keys from "@/data/screen-keys"

type Can = (action: Action) => boolean

const settingsNow = async () => {
  const { getWorkspaceSettings, peekWorkspaceSettings } = await import("@/data/workspace-settings")
  return peekWorkspaceSettings() ?? getWorkspaceSettings().catch(() => null)
}

const screens: Record<string, (ws: string, can: Can) => Promise<unknown>> = {
  dashboard: async (ws, can) => {
    const [{ getDashboard, reportFilters }, { listAutomationTemplates }] = await Promise.all([import("@/data/dashboard"), import("@/data/automation-templates")])
    const { period, channel } = keys.dashboardDefaults
    // "Comece aqui" só aparece a quem administra e depende das preferências do espaço.
    // A lista de conexões fica de fora: essa leitura pode consultar o provedor (aprender o id da conta) e não deve sair sem a pessoa abrir a tela.
    return Promise.all([
      primeAsync(keys.dashboardKey(ws, period, channel), () => getDashboard(ws, reportFilters(period, channel))),
      ...can("team") ? [settingsNow(), primeAsync(keys.inicioModelosKey(ws), () => listAutomationTemplates())] : [],
    ])
  },
  contacts: async ws => {
    const [data, { listSegments, emptyContactFilter }] = await Promise.all([import("@/data"), import("@/data/segments")])
    const lateral = Promise.all([
      primeAsync(keys.contactsKeys.segments(ws), listSegments),
      primeAsync(keys.contactsKeys.tags(ws), () => data.listTags(ws)),
      primeAsync(keys.contactsKeys.facets(ws), data.getContactFacets),
      primeAsync(keys.contactsKeys.fields(ws), () => data.listFields(ws)),
    ])
    // A lista depende de "mostrar só inscritos" do espaço: sem a preferência a identidade não bateria com a da tela.
    const onlySubscribed = (await settingsNow())?.show_only_subscribed ?? false
    const list = primeAsync(keys.contactsListKey(ws, { tagId: null, q: "", advanced: emptyContactFilter(), emailFilters: {}, onlySubscribed }),
      () => data.listContacts(ws, null, keys.contactsListFilter(null, "", {}, onlySubscribed)))
    return Promise.all([lateral, list])
  },
  automations: async ws => {
    const { listFolders, listAutomationLibrary } = await import("@/data")
    // A lista abre na raiz (endereço sem filtros): mesmo filtro e identidade que a tela calcula do endereço.
    const filter = keys.automationLibraryFilter(new URLSearchParams())
    return Promise.all([
      primeAsync(keys.automationFoldersKey(ws), () => listFolders(ws)),
      primeAsync(keys.automationLibraryKey(ws, filter), () => listAutomationLibrary(ws, filter)),
    ])
  },
  inbox: async ws => {
    const [{ listInbox }, { listInboxLabels, listInboxMentions }] = await Promise.all([import("@/data/inbox"), import("@/data/inbox-team")])
    const filter = keys.inboxListFilter(keys.inboxDefaults)
    return Promise.all([
      primeAsync(keys.inboxListKey(ws, filter), () => listInbox(ws, filter)),
      primeAsync(keys.inboxLabelsKey(ws), listInboxLabels),
      primeAsync(keys.inboxMentionsKey(ws), listInboxMentions),
    ])
  },
  broadcasts: async ws => {
    const { loadBroadcastsPage } = await import("@/data/broadcasts")
    return primeAsync(keys.broadcastsKey(ws), () => loadBroadcastsPage(ws))
  },
  /** Abre na aba Geral (as outras abas aquecem pelo menu lateral das Configurações). */
  settings: async ws => {
    const { getSettings } = await import("@/data/settings")
    return primeAsync(keys.settingsKeys.general(ws), () => getSettings(ws, keys.settingsParts("general")))
  },
  insights: async ws => {
    const { getInsights, getInboxInsights } = await import("@/data/insights")
    const { period, channel } = keys.insightsDefaults
    return Promise.all([
      primeAsync(keys.insightsKey(ws, period, channel), () => getInsights(ws, period, channel)),
      primeAsync(keys.insightsInboxKey(ws, period), () => getInboxInsights(period)),
    ])
  },
}

/** Aquece a tela `href` do menu (relativo ao espaço). Quem não lê automações não aquece as telas delas: o motor recusaria. */
export function primeScreen(href: string, ws: string, can: Can) {
  if (isFakeMode() || (automationAreas.includes(href) && !can("automation:read"))) return
  void screens[href]?.(ws, can).catch(() => undefined)
}

/** Em ocioso, depois da primeira tela: só as mais abertas (caixa de entrada e início), não o menu inteiro. */
export function primeFrequentScreens(ws: string, can: Can, current: string | undefined) {
  if (isFakeMode()) return
  const run = () => { for (const href of ["inbox", "dashboard"]) if (href !== current) primeScreen(href, ws, can) }
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 3000 })
  else setTimeout(run, 1500)
}
