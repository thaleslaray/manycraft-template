import * as React from "react"
import { Blocks, ShoppingBasket, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { useParams } from "react-router"
import { apiRequest, isFakeMode } from "@/data/api"
import { useAsync } from "@/hooks/use-async"
import { settingsKeys } from "@/data/screen-keys"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { SettingsCard } from "./settings-rows"

export type InstalledApp = { id: string; name: string; version?: string; created_at: number; actions: { name: string; label: string; form: { name: string; label: string; type: "string" | "number" | "select"; source?: string }[] }[]; auth_params: { name: string; label: string }[] }
export const listApps = () => isFakeMode() ? Promise.resolve([] as InstalledApp[]) : apiRequest<{ items: InstalledApp[] }>("/apps").then(r => r.items)

/** Configurações > Aplicativos: os apps instalados (ícone, nome, versão, lixeira) e, num pop-up, a instalação de um app descrito por JSON (auth APIKEY, actions, sources). */
export function AppsSettings() {
  const { workspace = "" } = useParams()
  const list = useAsync(listApps, "apps", { cache: settingsKeys.apps(workspace) })
  const [open, setOpen] = React.useState(false)
  const [spec, setSpec] = React.useState("")
  const [params, setParams] = React.useState<Record<string, string>>({})
  const parsed = React.useMemo(() => { try { return JSON.parse(spec) as { auth?: { params?: { name: string; label: string }[] } } } catch { return null } }, [spec])
  const act = (p: Promise<unknown>, ok: string) => p.then(() => { toast.success(ok); list.reload(); return true }).catch((e: Error) => { toast.error(e.message); return false })
  const apps = list.data ?? []
  const cols = "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem]"
  return <section aria-label="Apps" className="min-w-0 space-y-6">
    <SettingsCard title="Aplicativos instalados" action={<Button onClick={() => setOpen(true)}><ShoppingBasket className="size-4" aria-hidden="true" />Instalar aplicativo</Button>}>
      <div className="px-4 pb-2 sm:px-6">
        <div className={`hidden gap-4 border-t border-border py-3 text-sm font-semibold sm:grid ${cols}`}><span>Nome</span><span>Versão</span><span /></div>
        {apps.length ? <ul>{apps.map(a => <li key={a.id} className={`grid items-center gap-x-4 gap-y-1 border-t border-border py-1 text-sm first:border-t-0 sm:first:border-t ${cols}`}>
          <p className="flex min-w-0 items-center gap-3"><span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"><Blocks className="size-3.5" /></span><span className="truncate">{a.name}</span></p>
          <p className="text-text-muted" title={`${a.actions.length} ${a.actions.length === 1 ? "ação" : "ações"} · instalado em ${new Date(a.created_at).toLocaleDateString("pt-BR")}`}>{a.version ?? "1.0"}</p>
          <Button size="sm" variant="ghost" aria-label={`Remover ${a.name}`} className="justify-self-end text-text-muted" onClick={() => { if (window.confirm(`Remover o app ${a.name}?`)) void act(apiRequest(`/apps/${a.id}`, { method: "DELETE" }), "App removido.") }}><Trash2 className="size-4" aria-hidden="true" /></Button></li>)}</ul>
          : <p className="border-t border-border py-4 text-sm text-text-muted">{list.loading ? "Carregando…" : "Nenhum aplicativo instalado ainda."}</p>}
      </div>
    </SettingsCard>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent>
      <DialogHeader><DialogTitle>Instalar aplicativo</DialogTitle><DialogDescription>Cole a descrição JSON do app (autenticação, ações e listas). As ações aparecem no passo de Ações do editor.</DialogDescription></DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1"><Label htmlFor="app-spec" className="sr-only">JSON do app</Label><Textarea id="app-spec" aria-label="JSON do app" rows={8} className="font-mono text-xs" value={spec} onChange={e => setSpec(e.target.value)} /></div>
        {spec && !parsed ? <p role="alert" className="text-sm text-danger">JSON inválido.</p> : null}
        {(parsed?.auth?.params ?? []).map(p => <div key={p.name} className="space-y-1"><Label htmlFor={`app-param-${p.name}`}>{p.label}</Label><Input id={`app-param-${p.name}`} type="password" value={params[p.name] ?? ""} onChange={e => setParams({ ...params, [p.name]: e.target.value })} /></div>)}
      </div>
      <DialogFooter><Button variant="secondary" onClick={() => setOpen(false)}>Cancelar</Button>
        <Button disabled={!parsed} onClick={() => void act(apiRequest("/apps", { method: "POST", body: JSON.stringify({ spec: parsed, params }) }).then(() => { setSpec(""); setParams({}); setOpen(false) }), "App instalado.")}>Instalar app</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>
}
