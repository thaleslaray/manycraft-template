import * as React from "react"
import { Link, useSearchParams } from "react-router"
import { ImagePlus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { apiRequest } from "@/data/api"
import { updateGeneralSettings, type SettingsSnapshot } from "@/data"
import { saveWorkspaceSettings, uploadAccountPhoto } from "@/data/workspace-settings"
import { useWorkspaceSettings } from "@/hooks/use-workspace-settings"
import { useDraft } from "@/hooks/use-draft"
import { useCan, useRole } from "@/hooks/use-role"
import { AvatarInitials, initials } from "@/components/ui/avatar-initials"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { SettingsRow, SettingsRows } from "./settings-rows"
import type { Action } from "./items-panel"

const timezones = ["America/Sao_Paulo", "America/Manaus", "America/Recife", "America/Rio_Branco", "Europe/Lisbon", "UTC"]

/** Geral: uma linha por assunto, com o controle à esquerda; o que pede mais campos abre em pop-up pelo botão da linha. */
export function GeneralSettings({ snapshot, workspace, run, busy }: { snapshot: SettingsSnapshot; workspace: string; run: Action; busy: boolean }) {
  const [params, setParams] = useSearchParams()
  const [dialog, setDialog] = React.useState<"account" | "clone" | "template" | "delete" | null>(params.get("editar") === "conta" ? "account" : null)
  // O dado pode vir do cache: o fuso acompanha a revalidação até a pessoa escolher outro.
  const [timezone, setTimezone] = useDraft(snapshot.general.timezone)
  const prefs = useWorkspaceSettings()
  const admin = useCan("team")
  const role = useRole()
  const close = () => { setDialog(null); if (params.has("editar")) { const next = new URLSearchParams(params); next.delete("editar"); setParams(next, { replace: true }) } }
  const name = snapshot.general.name
  return <>
    <SettingsRows label="Geral">
      <SettingsRow label="Nome e foto da conta" help="Aparece no seletor de contas, nos relatórios e no topo do Insights. Também guarda as preferências de exibição da conta.">
        <div className="flex items-center gap-3">
          <span role="img" aria-label={prefs?.photo_url ? "Foto da conta" : `Conta sem foto, inicial ${initials(name).slice(0, 1)}`}><AvatarInitials name={name} src={prefs?.photo_url ?? undefined} className="size-10" /></span>
          <span className="min-w-0 flex-1 truncate font-medium" title={name}>{name}</span>
          <Button type="button" variant="secondary" onClick={() => setDialog("account")}>Editar<span className="sr-only"> nome e foto da conta</span></Button>
        </div>
      </SettingsRow>
      <SettingsRow label="Fuso horário" htmlFor="workspace-timezone" help="Usado para organizar horários e relatórios deste espaço.">
        <Select value={timezone} disabled={busy} onValueChange={value => { const before = timezone; setTimezone(value); void run(() => updateGeneralSettings(workspace, { name, timezone: value }), "Fuso horário salvo.").then(ok => { if (!ok) setTimezone(before) }) }}>
          <SelectTrigger id="workspace-timezone" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{timezones.map(zone => <SelectItem key={zone} value={zone}>{zone}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow label="Encurtamento de link" help="Cada canal liga ou desliga o encurtador dos links do texto. Desligado, não há dados sobre a taxa de cliques.">
        <Button variant="secondary" asChild><Link to={`/${workspace}/settings/channels`}>Ver nos canais</Link></Button>
      </SettingsRow>
      {admin ? <>
        <SettingsRow label="Copiar conta" help="Copie as automações (em rascunho, numa pasta Copiado), tags e campos para outra conta. Contatos, conexões e conversas não vão.">
          <Button type="button" onClick={() => setDialog("clone")}>Copiar esta conta</Button>
        </SettingsRow>
        <SettingsRow label="Usar como modelo" help="Crie uma cópia desta conta para servir de modelo. Ela nasce sem contatos nem conexões.">
          <Button type="button" onClick={() => setDialog("template")}>Criar um modelo de conta</Button>
        </SettingsRow>
      </> : null}
      <SettingsRow label="Modo agência" help="Veja e troque entre todos os espaços de clientes.">
        <Button variant="secondary" asChild><Link to={`/${workspace}/agency`}>Ver espaços de clientes</Link></Button>
      </SettingsRow>
      <LeaveRow owner={role === "owner"} workspace={workspace} />
      <SettingsRow danger label="Excluir conta" help="Apaga seu login e os espaços em que você é o dono, com tudo dentro.">
        <Button type="button" variant="secondary" className="border-danger text-danger" onClick={() => setDialog("delete")}>Apagar<span className="sr-only"> minha conta</span></Button>
      </SettingsRow>
    </SettingsRows>
    {dialog === "account" && <AccountDialog snapshot={snapshot} workspace={workspace} run={run} busy={busy} onClose={close} />}
    {(dialog === "clone" || dialog === "template") && <CloneDialog template={dialog === "template"} sourceName={name} onClose={close} />}
    {dialog === "delete" && <DeleteDialog onClose={close} />}
  </>
}

/** Nome, foto e descrição da conta. O que a pessoa mexeu fica aqui; o resto acompanha as preferências quando chegam (digitar antes do carregamento não se perde). */
function AccountDialog({ snapshot, workspace, run, busy, onClose }: { snapshot: SettingsSnapshot; workspace: string; run: Action; busy: boolean; onClose: () => void }) {
  const prefs = useWorkspaceSettings()
  const [accountName, setAccountName] = useDraft(snapshot.general.name)
  const [photo, setPhoto] = React.useState<{ id: string | null; preview: string | null } | null>(null)   // null = foto como está salva
  const [photoBusy, setPhotoBusy] = React.useState(false)
  const [edits, setEdits] = React.useState<{ description?: string; show_only_subscribed?: boolean; hide_keywords_tab?: boolean; hide_rules_tab?: boolean }>({})
  const edit = (patch: typeof edits) => setEdits(current => ({ ...current, ...patch }))
  const description = edits.description ?? prefs?.description ?? ""
  const showOnlySubscribed = edits.show_only_subscribed ?? prefs?.show_only_subscribed ?? true
  const hideKeywords = edits.hide_keywords_tab ?? prefs?.hide_keywords_tab ?? false
  const hideRules = edits.hide_rules_tab ?? prefs?.hide_rules_tab ?? false
  const shown = photo ? photo.preview : prefs?.photo_url ?? null
  const previewUrl = React.useRef<string | null>(null)
  const setPreview = (url: string | null) => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = url }
  React.useEffect(() => () => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current) }, [])
  const chooseFile = async (file: File | undefined) => {
    if (!file) return
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { toast.error("A foto precisa ser PNG, JPG ou WebP."); return }
    if (file.size > 2 * 1024 * 1024) { toast.error("A foto precisa ter até 2 MB."); return }
    setPhotoBusy(true)
    try { const saved = await uploadAccountPhoto(file); const url = URL.createObjectURL(file); setPreview(url); setPhoto({ id: saved.id, preview: url }) }
    catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível enviar a foto.") }
    finally { setPhotoBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
      <DialogHeader><DialogTitle>Nome e foto da conta</DialogTitle><DialogDescription>Aparecem no seletor de contas e nos relatórios.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={event => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        void run(async () => {
          await updateGeneralSettings(workspace, { name: String(form.get("name")), timezone: snapshot.general.timezone })
          // Sem as preferências carregadas, só vai o que a pessoa mexeu: o resto não é sobrescrito com valores de fábrica.
          const known = (key: keyof typeof edits) => !!prefs || key in edits
          await saveWorkspaceSettings({ ...(photo ? { photo_media_id: photo.id } : {}),
            ...(known("description") ? { description: description.trim() || null } : {}),
            ...(known("show_only_subscribed") ? { show_only_subscribed: showOnlySubscribed } : {}),
            ...(known("hide_keywords_tab") ? { hide_keywords_tab: hideKeywords } : {}),
            ...(known("hide_rules_tab") ? { hide_rules_tab: hideRules } : {}) })
        }, "Preferências salvas.").then(ok => { if (ok) onClose() })
      }}>
        <div className="space-y-2"><Label htmlFor="workspace-name">Nome do espaço de trabalho</Label><Input id="workspace-name" name="name" maxLength={120} required value={accountName} onChange={event => setAccountName(event.target.value)} /></div>
        <div className="space-y-2">
          <Label htmlFor="workspace-photo">Foto da conta</Label>
          <div className="flex flex-wrap items-center gap-3">
            <span role="img" aria-label={shown ? "Foto da conta" : `Conta sem foto, inicial ${initials(snapshot.general.name).slice(0, 1)}`}><AvatarInitials name={snapshot.general.name} src={shown ?? undefined} className="size-14 text-lg" /></span>
            <input id="workspace-photo" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={event => { void chooseFile(event.target.files?.[0]); event.target.value = "" }} />
            <Button type="button" variant="secondary" loading={photoBusy} onClick={() => document.getElementById("workspace-photo")?.click()}><ImagePlus aria-hidden className="size-4" />{shown ? "Trocar foto" : "Enviar foto"}</Button>
            {shown ? <Button type="button" variant="secondary" onClick={() => { setPreview(null); setPhoto({ id: null, preview: null }) }}><Trash2 aria-hidden className="size-4" />Remover foto</Button> : null}
          </div>
          <p className="text-xs text-text-muted">PNG, JPG ou WebP, até 2 MB. Sem foto, aparece a inicial do nome.</p>
        </div>
        <div className="space-y-2"><Label htmlFor="workspace-description">Descrição da conta</Label><Textarea id="workspace-description" name="description" maxLength={280} rows={3} value={description} onChange={event => edit({ description: event.target.value })} /><p className="text-xs text-text-muted">Texto curto, até 280 caracteres. Opcional.</p></div>
        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-medium">Exibição</legend>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="show_only_subscribed" checked={showOnlySubscribed} onChange={event => edit({ show_only_subscribed: event.target.checked })} className="mt-0.5 size-4 accent-accent" /><span>Esconder descadastrados na lista de contatos<span className="block text-xs text-text-muted">A lista mostra só inscritos; dá para ver os demais na própria lista.</span></span></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="hide_keywords_tab" checked={hideKeywords} onChange={event => edit({ hide_keywords_tab: event.target.checked })} className="mt-0.5 size-4 accent-accent" /><span>Ocultar a aba Palavras-chave em Automação</span></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="hide_rules_tab" checked={hideRules} onChange={event => edit({ hide_rules_tab: event.target.checked })} className="mt-0.5 size-4 accent-accent" /><span>Ocultar a aba Regras em Automação</span></label>
        </fieldset>
        <DialogFooter><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" loading={busy} disabled={photoBusy}>Salvar preferências</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

/** Sair do espaço: o dono não sai (precisa passar a titularidade antes); o motor também recusa. */
function LeaveRow({ owner, workspace }: { owner: boolean; workspace: string }) {
  const [confirm, setConfirm] = React.useState(false)
  if (owner) return <SettingsRow label="Sair da conta" help={<>Passe a titularidade a outro membro da <Link className="font-semibold text-text underline underline-offset-2 hover:text-accent" to={`/${workspace}/settings/team`}>equipe</Link> se quiser sair desta conta.</>}>
    <Button type="button" variant="secondary" disabled>Sair</Button>
  </SettingsRow>
  return <SettingsRow label="Sair da conta" help="Você perde o acesso a este espaço. Para voltar, alguém precisa te convidar de novo.">
    {confirm ? <div className="flex gap-2"><Button type="button" variant="danger" onClick={async () => { try { await apiRequest("/team/leave", { method: "POST", body: "{}" }); window.location.assign("/") } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível sair.") } }}>Confirmar saída</Button><Button type="button" variant="secondary" onClick={() => setConfirm(false)}>Cancelar</Button></div>
      : <Button type="button" variant="secondary" onClick={() => setConfirm(true)}>Sair do espaço</Button>}
  </SettingsRow>
}

/** Copiar a conta (dono e administrador): espaço novo com automações em rascunho, tags e campos, sem contatos nem conexões. Serve também de modelo. */
function CloneDialog({ template, sourceName, onClose }: { template: boolean; sourceName: string; onClose: () => void }) {
  const [name, setName] = React.useState(template ? `Modelo de ${sourceName}`.slice(0, 120) : "")
  const [busy, setBusy] = React.useState(false)
  const title = template ? "Criar um modelo de conta" : "Copiar esta conta"
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>Cria outro espaço com as automações (em rascunho, numa pasta Copiado), tags e campos. Contatos, conexões e conversas não são copiados.</DialogDescription></DialogHeader>
      <div className="space-y-2"><Label htmlFor="clone-name">Nome do novo espaço</Label><Input id="clone-name" placeholder="Nome do novo espaço" value={name} maxLength={120} onChange={e => setName(e.target.value)} /></div>
      <DialogFooter><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button>
        <Button type="button" loading={busy} disabled={!name.trim()} onClick={async () => {
          setBusy(true)
          try { const r = await apiRequest<{ id: string }>("/workspaces/clone", { method: "POST", body: JSON.stringify({ name: name.trim() }) }); await apiRequest("/workspaces/switch", { method: "POST", body: JSON.stringify({ workspace_id: r.id }) }); window.location.assign(`/${r.id}`) }
          catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível copiar."); setBusy(false) }
        }}>Clonar</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

/** Excluir a própria conta: confirma com EXCLUIR; o dono perde os espaços em que é o único dono (com tudo dentro). */
function DeleteDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>Excluir minha conta</DialogTitle><DialogDescription>Não dá para desfazer.</DialogDescription></DialogHeader>
      <ul className="list-disc space-y-1 pl-5 text-sm text-text-muted"><li>Seu login e suas sessões são apagados.</li><li>Espaços em que você é o dono são apagados com contatos, automações e arquivos.</li><li>Nos demais espaços, só o seu acesso sai.</li></ul>
      <div className="space-y-2"><Label htmlFor="delete-account">Digite EXCLUIR para confirmar</Label><Input id="delete-account" placeholder="Digite EXCLUIR" value={text} autoComplete="off" onChange={e => setText(e.target.value)} /></div>
      <DialogFooter><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button>
        <Button type="button" variant="danger" loading={busy} disabled={text !== "EXCLUIR"} onClick={async () => {
          setBusy(true)
          try { const r = await fetch("/api/auth/delete-user", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); if (!r.ok) throw new Error("Entre de novo e tente outra vez."); window.location.assign("/login") }
          catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível excluir a conta."); setBusy(false) }
        }}>Excluir conta</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
