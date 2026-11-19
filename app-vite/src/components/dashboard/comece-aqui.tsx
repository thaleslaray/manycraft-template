import * as React from "react"
import { AtSign, Mail, MessageCircle, MessagesSquare, Send, Zap } from "lucide-react"
import { QuickAutomationDialog } from "@/components/automations/quick-automation-dialog"
import { AutomationTemplateDialog } from "@/components/automations/automation-template-dialog"
import { Button } from "@/components/ui/button"
import { listConnections } from "@/data"
import { listAutomationTemplates } from "@/data/automation-templates"
import { availability, casesFor, eligibleConnections, type UseCase } from "@/data/use-cases"
import { useAsync } from "@/hooks/use-async"
import { inicioModelosKey, onboardingConnectionsKey } from "@/data/screen-keys"
import { useCan } from "@/hooks/use-role"
import { useWorkspaceSettings } from "@/hooks/use-workspace-settings"

const channelIcons: Record<string, typeof Send> = { instagram: AtSign, whatsapp: MessageCircle, telegram: Send, messenger: MessagesSquare, email: Mail }

const sigla: Record<string, string> = { instagram: "IG", whatsapp: "WA", telegram: "TG", messenger: "MS", email: "E-mail" }

/** "Comece aqui": três cartões de modelo (casos de uso do objetivo + modelos da galeria); clicar monta o caso. */
export function ComeceAqui({ workspace, blankBusy, onBlank }: { workspace: string; blankBusy: boolean; onBlank: () => Promise<void> }) {
  const settings = useWorkspaceSettings()
  const admin = useCan("team")
  const connections = useAsync(() => listConnections(workspace), "onboarding-connections", { cache: onboardingConnectionsKey(workspace) })
  const templates = useAsync(() => listAutomationTemplates(), "inicio-modelos", { cache: inicioModelosKey(workspace) })
  const [picked, setPicked] = React.useState<UseCase | null>(null)
  const [gallery, setGallery] = React.useState(false)
  if (!settings || !admin) return null
  const goal = settings.profile_answers?.goal
  const cases = casesFor(goal && goal !== "skip" ? goal : "leads").slice(0, 3)
  const extra = (templates.data?.templates ?? []).slice(0, 3 - cases.length)
  const blocked = connections.loading || connections.error
  return <section aria-labelledby="start-title" className="mt-8 min-w-0 space-y-4">
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <h2 id="start-title" className="text-xl font-bold">Comece aqui</h2>
      <Button variant="link" className="p-0 text-sm" onClick={() => setGallery(true)}>Veja todos os modelos</Button>
    </div>
    {connections.error ? <p role="alert" className="text-sm text-danger">Não foi possível verificar seus canais. Os casos ficam bloqueados até a lista carregar.</p> : null}
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {cases.map(c => {
        const state = blocked ? { ok: false as const, reason: connections.loading ? "Verificando seus canais conectados…" : "Canais indisponíveis no momento." } : availability(c, connections.data ?? [])
        const kind = c.goal === "keyword" ? eligibleConnections(c.goal, connections.data ?? [])[0]?.kind : "instagram"
        return <li key={c.id} aria-label={c.title} className="min-w-0">
          <Card title={c.title} kind={kind} disabled={!state.ok} reason={state.ok ? undefined : state.reason} onClick={() => setPicked(c)} />
        </li>
      })}
      {extra.map(t => <li key={t.id} aria-label={t.name} className="min-w-0"><Card title={t.name} onClick={() => setGallery(true)} /></li>)}
    </ul>
    {picked ? <QuickAutomationDialog workspace={workspace} useCase={picked} onClose={() => setPicked(null)} /> : null}
    {gallery ? <AutomationTemplateDialog workspace={workspace} folderId={null} blankBusy={blankBusy} onBlank={onBlank} onClose={() => setGallery(false)} /> : null}
  </section>
}

function Card({ title, kind, disabled, reason, onClick }: { title: string; kind?: string; disabled?: boolean; reason?: string; onClick: () => void }) {
  const Icon = (kind && channelIcons[kind]) || MessageCircle
  return <button type="button" disabled={disabled} onClick={onClick} className="flex h-full min-h-25 w-full min-w-0 flex-col justify-between gap-2 rounded-lg bg-surface p-3 text-left shadow-card transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-surface">
    <span className="line-clamp-2 break-words text-base font-medium">{title}</span>
    {reason ? <span className="text-2xs text-warning">{reason}</span> : null}
    <span className="flex items-center gap-1.5 text-2xs text-text-muted"><Zap className="size-3.5" aria-hidden="true" />Automação rápida<Icon className="size-3.5" aria-hidden="true" />{kind && sigla[kind] ? <span aria-hidden="true">{sigla[kind]}</span> : null}</span>
  </button>
}
