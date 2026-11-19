import * as React from "react"
import { ChannelBadge } from "./channel-badge"
import { triggerPanelTitle } from "./trigger-catalog"
import { Copy, Download, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { deleteRefTrigger, saveRefTrigger, type Trigger, type TriggerRepeatMode, type TriggerState } from "@/data"
import { listConnections, type Connection } from "@/data/connections"
import { useAsync } from "@/hooks/use-async"
import { drawQr, qrPng } from "@/lib/qr"
import { apiRequest } from "@/data/api"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SidePanel } from "@/components/ui/side-panel"
import { Textarea } from "@/components/ui/textarea"
import { triggerPolicies } from "./keyword-trigger-panel"
import { NodeLinks, type PanelProps } from "./panel-shared"

/** Os canais com link público de abertura de conversa: wa.me, m.me e ig.me. */
export const REF_CHANNELS = ["whatsapp", "messenger", "instagram", "telegram"] as const
export const isRefConnection = (c: Connection) => c.status === "connected" && (REF_CHANNELS as readonly string[]).includes(c.kind)
export const handleLabel: Record<string, { label: string; hint: string; placeholder: string }> = {
  whatsapp: { label: "Número do WhatsApp", hint: "Com código do país e DDD, só dígitos.", placeholder: "5511999990000" },
  messenger: { label: "Nome da Página", hint: "O nome que aparece em m.me/nome (ou o ID da Página).", placeholder: "minha.pagina" },
  instagram: { label: "Usuário do Instagram", hint: "O nome de usuário da conta profissional, sem o @.", placeholder: "minha.conta" },
  telegram: { label: "Usuário do bot", hint: "O @ do bot no Telegram; o link abre o bot e manda /start com o código.", placeholder: "minhaloja_bot" },
}
const WHATSAPP_TEXT_MAX = 131 // 140 do pré-preenchido menos o espaço e os 8 caracteres do código

export function RefLinkPanel(p: PanelProps & { trigger: Trigger; picker: React.ReactNode }) {
  const { trigger, picker } = p
  const state: TriggerState = trigger.state ?? (trigger.active ? "active" : "draft")
  const saved = { name: trigger.name, connectionId: trigger.channel_id ?? "", handle: trigger.config.handle ?? "", text: trigger.config.text ?? "", payloadField: trigger.config.payload_field_id ?? "", state, repeat: (trigger.repeat_mode ?? "every_time") as TriggerRepeatMode }
  const [draft, setDraft] = React.useState(saved)
  const [saving, setSaving] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const [error, setError] = React.useState("")
  const connections = useAsync(() => listConnections(), "ref-connections")
  const eligible = connections.data?.filter(isRefConnection) ?? []
  const connection = eligible.find(c => c.id === draft.connectionId)
  const channel = connection?.kind ?? trigger.channel_type ?? "messenger"
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const unsaved = React.useRef(false)
  React.useEffect(() => { unsaved.current = dirty }, [dirty])
  React.useEffect(() => () => { if (unsaved.current) toast.warning("As alterações do link não foram salvas") }, [])
  const off = p.readOnly || saving
  const field = handleLabel[channel] ?? handleLabel.messenger
  const link = trigger.config.link ?? ""
  const set = (patch: Partial<typeof draft>) => setDraft(d => ({ ...d, ...patch }))

  async function save() {
    setSaving(true); setError("")
    try {
      const t = await saveRefTrigger(trigger.automation_id, trigger, { name: draft.name.trim(), connection_id: draft.connectionId, handle: draft.handle, text: channel === "whatsapp" ? draft.text : undefined, payload_field_id: draft.payloadField || null, state: draft.state, repeat_mode: draft.repeat })
      p.onTriggerChange(t)
      unsaved.current = false
      setDraft({ name: t.name, connectionId: t.channel_id ?? "", handle: t.config.handle ?? "", text: t.config.text ?? "", payloadField: t.config.payload_field_id ?? "", state: t.state ?? (t.active ? "active" : "draft"), repeat: t.repeat_mode ?? "every_time" })
      toast.success("Link salvo")
    } catch (e) { setError(e instanceof Error ? e.message : "Não consegui salvar o link.") }
    finally { setSaving(false) }
  }
  async function remove() {
    setSaving(true); setError("")
    try {
      await deleteRefTrigger(trigger.automation_id, trigger.id)
      unsaved.current = false
      setConfirming(false)
      p.onTriggerRemove?.(trigger.id)
      p.onClose()
      toast.success("Link excluído. Quem usar o link antigo não inicia mais esta automação.")
    } catch (e) { setError(e instanceof Error ? e.message : "Não consegui excluir o link."); setConfirming(false) }
    finally { setSaving(false) }
  }

  return <SidePanel title={triggerPanelTitle[trigger.type] ?? trigger.name} icon={<ChannelBadge channel={trigger.channel_type} />} tone="trigger" onClose={p.onClose} footer={
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="ghost" className="text-danger" disabled={off} onClick={() => setConfirming(true)}><Trash2 className="size-4" aria-hidden="true" />Excluir link</Button>
      <div className="ml-auto flex gap-2">
        <Button onClick={save} loading={saving} disabled={off || !dirty || !draft.name.trim() || !draft.connectionId || !draft.handle.trim()}>{dirty ? "Salvar" : "Salvo"}</Button>
      </div>
    </div>
  }>
    {picker}
    <div className="space-y-1">
      <Label htmlFor="ref-name">Nome do link</Label>
      <Input id="ref-name" value={draft.name} maxLength={100} disabled={off} onChange={e => set({ name: e.target.value })} />
    </div>
    <div className="space-y-1">
      <Label htmlFor="ref-connection">Conexão</Label>
      {connections.loading ? <p role="status" className="text-sm text-text-muted">Carregando conexões…</p> : connections.error ? <Banner variant="danger">Não consegui carregar as conexões.<Button variant="secondary" size="sm" onClick={connections.reload}>Tentar de novo</Button></Banner> : <>
        <Select value={draft.connectionId} disabled={off} onValueChange={connectionId => set({ connectionId })}>
          <SelectTrigger id="ref-connection"><SelectValue placeholder="Escolha uma conexão" /></SelectTrigger>
          <SelectContent>{eligible.map(c => <SelectItem key={c.id} value={c.id}>{c.displayName ?? c.label}</SelectItem>)}</SelectContent>
        </Select>
        {!connection ? <Banner variant="warning">Escolha uma conexão de WhatsApp, Messenger ou Instagram que esteja conectada.</Banner> : null}
      </>}
    </div>
    <div className="space-y-1">
      <Label htmlFor="ref-handle">{field.label}</Label>
      <Input id="ref-handle" value={draft.handle} maxLength={100} placeholder={field.placeholder} disabled={off} onChange={e => set({ handle: e.target.value })} aria-describedby="ref-handle-hint" />
      <p id="ref-handle-hint" className="text-xs text-text-muted">{field.hint}</p>
    </div>
    {channel === "whatsapp" ? <div className="space-y-1">
      <Label htmlFor="ref-text">Mensagem que já vem escrita</Label>
      <Textarea id="ref-text" value={draft.text} maxLength={WHATSAPP_TEXT_MAX} rows={3} disabled={off} onChange={e => set({ text: e.target.value })} aria-describedby="ref-text-hint" />
      <p id="ref-text-hint" className="text-xs text-text-muted">{draft.text.length}/{WHATSAPP_TEXT_MAX}. O código do link entra no fim do texto e é ele que inicia a automação: a pessoa só vira contato quando envia a mensagem.</p>
    </div> : null}
    {channel !== "whatsapp" ? <div className="space-y-1">
      <Label htmlFor="ref-payload">Guardar dados extras do link em</Label>
      <select id="ref-payload" className="h-10 w-full rounded-md border border-border-input bg-surface px-3 text-sm" disabled={off} value={draft.payloadField} onChange={e => set({ payloadField: e.target.value })}>
        <option value="">Não guardar</option>
        {(p.fields ?? []).filter(f => f.type === "text").map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
      <p className="text-xs text-text-muted">Acrescente <code>--valor</code> ao fim do código no link (ex.: <code>?ref=CODIGO--azul</code>) e o valor vai para este campo do contato.</p>
    </div> : null}
    <section aria-label="Link e QR code" className="space-y-3 rounded-md border border-border bg-surface p-3">
      {dirty ? <p className="text-xs text-warning">Salve para o link e o QR refletirem as mudanças.</p> : null}
      <Label htmlFor="ref-link">Link</Label>
      <div className="flex min-w-0 gap-2">
        <Input id="ref-link" readOnly value={link} className="min-w-0 flex-1" onFocus={e => e.currentTarget.select()} />
        <Button variant="secondary" disabled={!link} onClick={async () => {
          try { await navigator.clipboard.writeText(link); toast.success("Link copiado") } catch { toast.error("Não consegui copiar. Selecione o link e copie à mão.") }
        }}><Copy className="size-4" aria-hidden="true" />Copiar</Button>
      </div>
      {link ? <QrBlock link={link} name={trigger.name} /> : null}
      {link && link.startsWith("https://") ? <SiteWidget link={link} /> : null}
      <p className="text-xs text-text-muted">{channel === "whatsapp"
        ? "O WhatsApp não informa quantas pessoas abriram o link: aqui só contam as conversas que começaram."
        : "As aberturas do link e as conversas iniciadas aparecem nas métricas do gatilho."}</p>
    </section>
    <div className="space-y-1">
      <Label htmlFor="ref-state">Estado do link</Label>
      <Select value={draft.state} disabled={off} onValueChange={value => set({ state: value as TriggerState })}>
        <SelectTrigger id="ref-state"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="active" disabled={!p.published && draft.state !== "active"}>{p.published || draft.state === "active" ? "Ativo" : "Ativo (publique para ativar)"}</SelectItem><SelectItem value="draft">Desligado</SelectItem>{draft.state === "initial" ? <SelectItem value="initial">Inicial</SelectItem> : null}</SelectContent>
      </Select>
    </div>
    <div className="space-y-1">
      <Label htmlFor="ref-repeat">Política de disparo</Label>
      <Select value={draft.repeat} disabled={off} onValueChange={value => set({ repeat: value as TriggerRepeatMode })}>
        <SelectTrigger id="ref-repeat"><SelectValue /></SelectTrigger>
        <SelectContent>{Object.entries(triggerPolicies).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    {error ? <Banner variant="danger"><span role="alert">{error}</span></Banner> : null}
    <NodeLinks p={p} />
    <Dialog open={confirming} onOpenChange={open => { if (!open && !saving) setConfirming(false) }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Excluir este link?</DialogTitle><DialogDescription>O link e o QR já divulgados deixam de iniciar esta automação. Isso não pode ser desfeito.</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="secondary" disabled={saving} onClick={() => setConfirming(false)}>Cancelar</Button><Button variant="danger" loading={saving} onClick={remove}>Excluir link</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </SidePanel>
}

function QrBlock({ link, name }: { link: string; name: string }) {
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = React.useState(false)
  const [size, setSize] = React.useState(1024)
  const [dark, setDark] = React.useState("#000000")
  const [light, setLight] = React.useState("#ffffff")
  const [logo, setLogo] = React.useState<HTMLImageElement | null>(null)
  React.useEffect(() => {
    try { if (canvas.current) drawQr(canvas.current, link, 320, { dark, light, logo }); setFailed(false) } catch { setFailed(true) }
  }, [link, dark, light, logo])
  async function download() {
    try {
      const url = URL.createObjectURL(await qrPng(link, Math.min(2000, Math.max(100, size)), { dark, light, logo }))
      const a = document.createElement("a")
      a.href = url; a.download = `qr-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "link"}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch { toast.error("Não consegui gerar o PNG do QR code.") }
  }
  if (failed) return <Banner variant="warning">Não consegui gerar o QR code deste link.</Banner>
  return <div className="flex flex-wrap items-center gap-3">
    <canvas ref={canvas} role="img" aria-label="QR code do link" className="size-40 max-w-full rounded-md border border-border bg-white" />
    <div className="space-y-2 text-sm">
      <label className="flex items-center gap-2">Tamanho (px)<input type="number" min={100} max={2000} step={50} value={size} onChange={e => setSize(Number(e.target.value))} className="w-24 rounded-md border border-border-input bg-surface px-2 py-1" /></label>
      <label className="flex items-center gap-2">Cor do código<input type="color" value={dark} onChange={e => setDark(e.target.value)} /></label>
      <label className="flex items-center gap-2">Cor do fundo<input type="color" value={light} onChange={e => setLight(e.target.value)} /></label>
      <label className="flex items-center gap-2">Logo<Input type="file" accept="image/png,image/jpeg" onChange={e => { const f = e.target.files?.[0]; if (!f) { setLogo(null); return } const img = new Image(); img.onload = () => setLogo(img); img.src = URL.createObjectURL(f) }} /></label>
      <Button variant="secondary" onClick={download}><Download className="size-4" aria-hidden="true" />Baixar QR em PNG</Button>
    </div>
  </div>
}

/** Widget de site: botão flutuante no seu site que abre esta conversa; o diagnóstico confere HTTPS e a instalação do script. */
function SiteWidget({ link }: { link: string }) {
  const [widget, setWidget] = React.useState<{ id: string } | null>(null)
  const [label, setLabel] = React.useState("Fale com a gente")
  const [page, setPage] = React.useState("")
  const [checks, setChecks] = React.useState<{ check: string; ok: boolean; detail: string }[] | null>(null)
  const snippet = widget ? `<script src="${window.location.origin}/api/site-widget/${widget.id}.js" async></script>` : ""
  return <div className="space-y-2 rounded-md border border-border p-3 text-sm">
    <p className="font-semibold">Widget no seu site</p>
    {!widget ? <div className="flex flex-wrap gap-2"><input aria-label="Texto do botão" value={label} maxLength={60} onChange={e => setLabel(e.target.value)} className="min-w-0 flex-1 rounded-md border border-border-input bg-surface px-2 py-1" />
      <Button size="sm" onClick={async () => { try { setWidget(await apiRequest<{ id: string }>("/site-widgets", { method: "POST", body: JSON.stringify({ label, target_url: link }) })) } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível criar.") } }}>Criar widget</Button></div>
      : <><pre className="overflow-x-auto rounded bg-surface-muted p-2 text-xs">{snippet}</pre>
        <div className="flex flex-wrap gap-2"><input aria-label="Página onde instalou" placeholder="https://seusite.com" value={page} onChange={e => setPage(e.target.value)} className="min-w-0 flex-1 rounded-md border border-border-input bg-surface px-2 py-1" />
          <Button size="sm" variant="secondary" disabled={!page} onClick={async () => { try { setChecks((await apiRequest<{ checks: { check: string; ok: boolean; detail: string }[] }>(`/site-widgets/${widget.id}/diagnose`, { method: "POST", body: JSON.stringify({ page_url: page }) })).checks) } catch (e) { toast.error(e instanceof Error ? e.message : "Falha no diagnóstico.") } }}>Diagnosticar</Button></div>
        {checks ? <ul className="space-y-1">{checks.map(c => <li key={c.check} className={c.ok ? "text-success" : "text-danger"}>{c.ok ? "✓" : "✗"} {c.detail}</li>)}</ul> : null}</>}
  </div>
}
