/**
 * Aquece o dado de cada aba das Configurações ao passar o mouse, focar ou tocar no item do menu lateral, com a mesma
 * identidade e a mesma função que a aba usa. Vive no pedaço das Configurações (as abas já estão carregadas), não na carga inicial.
 * Abas que só leem `/connections` (Instagram, WhatsApp, Telegram) ficam de fora: essa leitura pode consultar o provedor do canal.
 * A Hotmart também: a URL do webhook leva o segredo e não vai para o cache.
 */
import type { Action } from "../../../../shared/permissions"
import { isFakeMode } from "@/data/api"
import { getSettings } from "@/data/settings"
import { getTeam } from "@/data/team"
import { getEmailMetrics, getEmailSettings } from "@/data/email"
import { listWorkspaceLogs } from "@/data/external-requests"
import { listInboxLabels } from "@/data/inbox-team"
import { settingsKeys, settingsParts } from "@/data/screen-keys"
import { primeAsync } from "@/hooks/use-async"
import { settingsAllowed, type SettingsId } from "./settings-sections"
import { listProfileKeys } from "@/data/profile-keys"
import { loadMemberAlerts, loadNoticePrefs } from "./member-alerts"
import { loadCompliance } from "./compliance-settings"
import { loadInboxSettings } from "./inbox-settings"
import { loadAssignment } from "./inbox-assignment"
import { loadMarketingProvider } from "@/components/email/email-settings"
import { listApps } from "./apps-settings"
import { loadPixel, loadSheetsStatus } from "./integrations-settings"
import { loadInstalledTemplates } from "./installed-templates"

const tabs: Partial<Record<SettingsId, (ws: string) => Promise<unknown>[]>> = {
  general: ws => [primeAsync(settingsKeys.general(ws), () => getSettings(ws, settingsParts("general")))],
  notices: ws => [primeAsync(settingsKeys.memberAlerts(ws), loadMemberAlerts), primeAsync(settingsKeys.noticePrefs(ws), loadNoticePrefs)],
  team: ws => [primeAsync(settingsKeys.team(ws), getTeam)],
  logs: ws => [primeAsync(settingsKeys.logs(ws, true, "", ""), () => listWorkspaceLogs({ errors: true })), primeAsync(settingsKeys.logsTotals(ws), () => listWorkspaceLogs({ errors: false }))],
  compliance: ws => [primeAsync(settingsKeys.compliance(ws), loadCompliance)],
  inbox: ws => [primeAsync(settingsKeys.inbox(ws), loadInboxSettings), primeAsync(settingsKeys.inboxLabels(ws), listInboxLabels)],
  assignment: ws => [primeAsync(settingsKeys.assignment(ws), loadAssignment)],
  email: ws => [primeAsync(settingsKeys.email(ws), getEmailSettings), primeAsync(settingsKeys.emailMetrics(ws), getEmailMetrics), primeAsync(settingsKeys.marketingProvider(ws), loadMarketingProvider)],
  fields: ws => [primeAsync(settingsKeys.fields(ws), () => getSettings(ws, settingsParts("fields")))],
  tags: ws => [primeAsync(settingsKeys.tags(ws), () => getSettings(ws, settingsParts("tags")))],
  api: ws => [primeAsync(settingsKeys.api(ws), () => getSettings(ws, settingsParts("api"))), primeAsync(settingsKeys.profileApiKey(ws), listProfileKeys)],
  apps: ws => [primeAsync(settingsKeys.apps(ws), listApps)],
  integrations: ws => [primeAsync(settingsKeys.sheets(ws), loadSheetsStatus), primeAsync(settingsKeys.pixel(ws), loadPixel)],
  installed: ws => [primeAsync(settingsKeys.installed(ws), loadInstalledTemplates)],
}

/** Aquece a aba `id` se o papel pode abri-la (o menu esconde as outras e o motor recusaria). */
export function primeSettingsTab(id: SettingsId, ws: string, can: (action: Action) => boolean) {
  if (isFakeMode() || !settingsAllowed(can, id)) return
  tabs[id]?.(ws)
}
