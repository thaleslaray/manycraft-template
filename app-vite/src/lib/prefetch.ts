/** Telas do menu principal: baixadas em segundo plano depois da primeira tela, para o clique trocar de tela na hora. */
export function prefetchPages() {
  const loads = [
    () => import("@/components/dashboard/dashboard-page"),
    () => import("@/components/contacts/contacts-view"),
    () => import("@/components/automations/automations-list"),
    () => import("@/components/inbox/inbox-page"),
    () => import("@/components/broadcasts/broadcasts-page"),
    () => import("@/components/insights/insights-page"),
    () => import("@/components/settings/settings-page"),
    () => import("@/components/editor/flow-editor"),
  ]
  const run = () => { for (const load of loads) void load().catch(() => undefined) }
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 3000 })
  else setTimeout(run, 1500)
}
