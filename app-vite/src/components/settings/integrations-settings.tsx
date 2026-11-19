import * as React from "react"
import { Sheet, ShoppingBag, Target } from "lucide-react"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import { useAsync } from "@/hooks/use-async"
import { useCan } from "@/hooks/use-role"
import { useParams } from "react-router"
import { settingsKeys } from "@/data/screen-keys"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { SettingsRow, SettingsRows } from "./settings-rows"

type Status = { connected: boolean; client_email?: string }
export const loadSheetsStatus = () => isFakeMode() ? Promise.resolve<Status>({ connected: false }) : apiRequest<Status>("/integrations/google-sheets")

/** Nome da integração com ícone em círculo, no controle de cada linha. */
function Brand({ icon: Icon, name }: { icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>; name: string }) {
  return <p className="mb-5 flex items-center gap-3 text-base"><span aria-hidden="true" className="grid size-9 place-items-center text-accent"><Icon className="size-8" aria-hidden="true" /></span>{name}</p>
}

/** Configurações > Integrações: Google Sheets por conta de serviço (o JSON fica cifrado no motor), Hotmart e Pixel. */
export function IntegrationsSettings() {
  const { workspace = "" } = useParams()
  // Só o estado e o e-mail da conta de serviço; o JSON (com a chave privada) fica cifrado no motor e nunca volta.
  const status = useAsync(loadSheetsStatus, "google-sheets", { cache: settingsKeys.sheets(workspace) })
  const [json, setJson] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  async function run(task: () => Promise<unknown>, ok: string) {
    setBusy(true)
    try { await task(); toast.success(ok); setJson(""); status.reload() } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível salvar.") } finally { setBusy(false) }
  }
  return <section aria-label="Integrações" className="min-w-0 space-y-6">
    <h2 className="sr-only">Integrações</h2>
    <Banner>Se você ou os seus contatos estiverem na Área Econômica Europeia, obtenha o consentimento dos contatos antes de enviar os dados deles a qualquer serviço que você integrar, para ficar em conformidade com o GDPR.</Banner>
    <SettingsRows label="Google Sheets">
      <SettingsRow label="Conectar conta Google Sheets" help="Essa integração permite salvar os contatos do espaço direto em uma planilha do Google Sheets.">
        <Brand icon={Sheet} name="Google Sheets" />
        <div className="space-y-3">
          {status.data?.connected ? <p className="text-sm">Conectado com <span className="font-mono break-all">{status.data.client_email}</span>. Compartilhe cada planilha com este e-mail (Editor).</p>
            : <p className="text-sm text-text-muted">No Google Cloud, crie uma conta de serviço com a API do Google Sheets ativa, gere uma chave JSON e cole abaixo. Depois compartilhe a planilha com o e-mail da conta.</p>}
          <div className="space-y-1"><Label htmlFor="sheets-json">JSON da conta de serviço</Label>
            <Textarea id="sheets-json" rows={3} value={json} onChange={e => setJson(e.target.value)} placeholder='{"type": "service_account", "client_email": "...", "private_key": "..."}' className="font-mono text-xs" /></div>
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} disabled={!json.trim()} onClick={() => void run(() => apiRequest("/integrations/google-sheets", { method: "PUT", body: JSON.stringify({ service_account: json }) }), "Google Sheets conectado.")}>{status.data?.connected ? "Trocar conta" : "Conectar"}</Button>
            {status.data?.connected ? <Button variant="ghost" disabled={busy} onClick={() => void run(() => apiRequest("/integrations/google-sheets", { method: "DELETE" }), "Google Sheets desconectado.")}>Desconectar</Button> : null}
          </div>
        </div>
      </SettingsRow>
      {status.data?.connected ? <ExportContacts /> : null}
    </SettingsRows>
    <Hotmart />
    <Pixel />
  </section>
}

/** Webhook da Hotmart: gera a URL  para registrar na Hotmart (Ferramentas > Webhook). O hottok, opcional, confere a origem. */
function Hotmart() {
  // Sem cache: a URL do webhook leva o segredo que autentica a Hotmart.
  const hook = useAsync<{ url?: string | null; configured?: boolean; last_received_at?: number | null }>(() => isFakeMode() ? Promise.resolve({ url: null }) : apiRequest("/integrations/hotmart"), "hotmart")
  const canTeam = useCan("team")
  const [hottok, setHottok] = React.useState("")
  const save = async (body: object, ok: string) => { try { await apiRequest("/integrations/hotmart", { method: "PUT", body: JSON.stringify(body) }); toast.success(ok); hook.reload() } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível gerar.") } }
  return <SettingsRows label="Hotmart">
    <SettingsRow label="Conectar conta Hotmart" help="Registre esta URL na Hotmart (Ferramentas > Webhook, versão 2.0). Compras e carrinhos abandonados disparam as automações com gatilho Hotmart.">
      <Brand icon={ShoppingBag} name="Hotmart" />
      <div className="space-y-3">
        {hook.data?.url ? <p className="break-all rounded-md bg-surface-muted p-2 font-mono text-xs">{hook.data.url}</p> : null}
        {hook.data?.last_received_at ? <p className="text-xs text-text-muted">Último evento: {new Date(hook.data.last_received_at).toLocaleString("pt-BR")}</p> : null}
        {canTeam ? <>
          <div className="space-y-1"><Label htmlFor="hottok">Hottok (opcional)</Label>
            <input id="hottok" className="h-10 w-full rounded-md border border-border-input bg-surface px-3 text-sm" value={hottok} onChange={e => setHottok(e.target.value)} /></div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void save(hottok.trim() ? { hottok: hottok.trim() } : {}, "Webhook da Hotmart pronto.")}>{hook.data?.url ? "Salvar hottok" : "Gerar URL"}</Button>
            {hook.data?.url ? <Button size="sm" variant="secondary" onClick={() => { if (window.confirm("Gerar uma nova URL? A URL atual para de funcionar na hora e você precisa registrar a nova na Hotmart.")) void save({ rotate: true }, "Nova URL gerada. Registre-a na Hotmart.") }}>Gerar nova URL</Button> : null}
          </div>
        </> : <p className="text-sm text-text-muted">{hook.data?.configured ? "Webhook configurado. Só administradores veem a URL." : "Webhook ainda não configurado. Peça a um administrador."}</p>}
      </div>
    </SettingsRow>
  </SettingsRows>
}

type PixelState = { enabled: boolean; events: { id: string; kind: "conversion" | "money"; name: string | null; amount: number | null; currency: string | null; created_at: number; contact_name: string }[] }
export const loadPixel = () => isFakeMode() ? Promise.resolve<PixelState>({ enabled: false, events: [] }) : apiRequest<PixelState>("/pixel")
/** Pixel: script para o site; os links rastreados levam o mcp_token (28 dias) e o site registra conversões e valores do contato. */
function Pixel() {
  const { workspace = "" } = useParams()
  const state = useAsync(loadPixel, "pixel", { cache: settingsKeys.pixel(workspace) })
  const snippet = `<script src="${window.location.origin}/api/pixel.js" async></script>`
  const toggle = (enabled: boolean) => apiRequest("/pixel", { method: "PUT", body: JSON.stringify({ enabled }) }).then(() => { toast.success(enabled ? "Pixel ligado." : "Pixel desligado."); state.reload() }).catch((e: Error) => toast.error(e.message))
  return <SettingsRows label="Pixel">
    <SettingsRow label="Pixel do site" help={<>Cole o script no seu site. Quem chega por um link rastreado das automações é reconhecido por 28 dias; no site chame <code className="break-all">MC_PIXEL.fireLogConversionEvent("nome")</code> ou <code>MC_PIXEL.fireLogMoneyEvent(49.9, "BRL")</code>.</>}>
      <Brand icon={Target} name="Pixel" />
      <div className="space-y-3">
        <pre className="overflow-x-auto rounded bg-surface-muted p-2 text-xs">{snippet}</pre>
        <div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(snippet).then(() => toast.success("Script copiado."))}>Copiar script</Button>
          <Button size="sm" variant={state.data?.enabled ? "ghost" : "primary"} onClick={() => void toggle(!state.data?.enabled)}>{state.data?.enabled ? "Desligar" : "Ligar Pixel"}</Button></div>
        {state.data?.events.length ? <ul className="divide-y divide-border text-sm">{state.data.events.map(e => <li key={e.id} className="flex justify-between gap-2 py-2">
          <span>{e.contact_name || "Contato"} · {e.kind === "money" ? `${e.amount?.toLocaleString("pt-BR", { style: "currency", currency: e.currency ?? "BRL" })}` : `conversão ${e.name ?? ""}`}</span>
          <span className="text-text-muted">{new Date(e.created_at).toLocaleString("pt-BR")}</span></li>)}</ul> : null}
      </div>
    </SettingsRow>
  </SettingsRows>
}

/** Exportar contatos: todos os contatos do espaço vão para uma aba da planilha (cabeçalho + uma linha por contato). */
function ExportContacts() {
  const [sheetId, setSheetId] = React.useState("")
  const [tab, setTab] = React.useState("Contatos")
  const [busy, setBusy] = React.useState(false)
  const id = sheetId.match(/\/d\/([\w-]+)/)?.[1] ?? sheetId.trim()
  return <SettingsRow label="Exportar contatos para a planilha" help="Todos os contatos do espaço vão para uma aba da planilha: cabeçalho e uma linha por contato.">
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[1fr_10rem]"><div className="space-y-1"><Label htmlFor="export-sheet">Link ou ID da planilha</Label><Input id="export-sheet" value={sheetId} onChange={e => setSheetId(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="export-tab">Aba</Label><Input id="export-tab" value={tab} maxLength={100} onChange={e => setTab(e.target.value)} /></div></div>
      <Button size="sm" loading={busy} disabled={id.length < 10 || !tab.trim()} onClick={async () => {
        setBusy(true)
        try { const r = await apiRequest<{ exported: number }>("/integrations/google-sheets/export-contacts", { method: "POST", body: JSON.stringify({ spreadsheet_id: id, sheet: tab.trim() }) }); toast.success(`${r.exported} contatos exportados.`) }
        catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível exportar.") } finally { setBusy(false) }
      }}>Exportar</Button>
    </div>
  </SettingsRow>
}
