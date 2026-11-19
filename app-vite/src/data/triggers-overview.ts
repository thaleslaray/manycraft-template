import { apiRequest } from "./api"

export type TriggerTarget =
  | { kind: "automation"; automation_id: string; automation_name: string }
  | { kind: "screen"; screen: "basic" | "rules" }
export type OverviewItem = { id: string; name: string; type_channel: string; type_key?: string; type_code?: number | null; active: boolean; runs_30d: number; target: TriggerTarget }
export type OverviewFamily = { id: string; label: string; active: number; total: number; runs_30d: number; items: OverviewItem[] }

/** Todos os gatilhos da conta agrupados por família (só as famílias que têm gatilho). */
export function getTriggersOverview(): Promise<{ families: OverviewFamily[] }> {
  return apiRequest("/triggers/overview")
}

/** Para onde o gatilho leva: a automação dele ou a tela própria (Básico, Regras). */
export function targetPath(workspace: string, target: TriggerTarget): string {
  if (target.kind === "automation") return `/${workspace}/automations/${encodeURIComponent(target.automation_id)}`
  return `/${workspace}/automations/${target.screen === "rules" ? "rules" : "basic"}`
}
