import * as React from "react"
import { Eye, Mail, MousePointerClick, Pencil } from "lucide-react"
import { useParams } from "react-router"
import { getEmailContact, updateEmailContact } from "@/data/email"
import { listConnections } from "@/data/connections"
import { useAsync } from "@/hooks/use-async"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const segmentLabels = { opened_clicked: "Abriu e clicou", opened_not_clicked: "Abriu e não clicou", not_opened: "Ainda não abriu" }
const dateLabel = (value: number | null) => value ? new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "Nenhum registro"

export function ContactEmailSection({ contactId, onChanged }: { contactId: string; onChanged: () => unknown }) {
  const { workspace = "" } = useParams()
  const connections = useAsync(() => listConnections(workspace), workspace)
  const enabled = (connections.data ?? connections.stale ?? []).some(connection => connection.status === "connected" && connection.profile?.email)
  const profile = useAsync(() => enabled ? getEmailContact(contactId) : Promise.resolve(null), `${contactId}|${enabled}`)
  const snapshot = profile.data ?? profile.stale
  const current = snapshot?.channels[0]
  const [editing, setEditing] = React.useState(false)
  const [address, setAddress] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [consent, setConsent] = React.useState(false)
  if (!enabled) return null
  async function save(input: { address?: string; optedIn?: boolean; consent?: boolean }) {
    setBusy(true)
    setError("")
    try {
      await updateEmailContact(contactId, input)
      setEditing(false)
      setConsent(false)
      profile.reload()
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível atualizar o e-mail.")
    } finally { setBusy(false) }
  }
  return <section aria-label="E-mail do contato" className="space-y-3 rounded-md border border-border p-3">
    <h3 className="flex items-center gap-2 text-xs font-semibold text-text-muted"><Mail className="size-4" aria-hidden="true" />E-mail do contato</h3>
    {error ? <Banner variant="danger">{error}</Banner> : null}
    {profile.error ? <Banner variant="danger">Não foi possível consultar o e-mail.<Button size="sm" variant="secondary" onClick={profile.reload}>Tentar novamente</Button></Banner> : !snapshot ? <p role="status" className="text-xs text-text-muted">Carregando e-mail…</p> : <>
      {editing ? <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void save({ address }) }}>
        <Input aria-label="E-mail" type="email" required autoFocus maxLength={254} value={address} onChange={event => setAddress(event.target.value)} disabled={busy} />
        <Button size="sm" type="submit" loading={busy}>Salvar e-mail</Button><Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancelar</Button>
      </form> : <button type="button" aria-label={`Editar E-mail: ${current?.address ?? "vazio"}`} disabled={busy} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-surface-muted" onClick={() => { setAddress(current?.address ?? ""); setEditing(true) }}><span className="min-w-0 flex-1 break-all">{current?.address ?? "Definir endereço de e-mail"}</span><Pencil className="size-3 shrink-0 text-text-muted" aria-hidden="true" /></button>}
      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-xs text-text-muted">Opt-in de e-mail</p>
        <p className={`text-sm font-medium ${current?.optedIn ? "text-success" : "text-text-muted"}`}>{current?.optedIn ? "Marketing por e-mail autorizado" : "Marketing por e-mail desativado"}</p>
        {current?.optedIn ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void save({ optedIn: false })}>Descadastrar do e-mail</Button> : current ? <div className="space-y-2"><label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} className="mt-0.5" />Confirmo que o contato autorizou marketing por e-mail.</label><Button size="sm" variant="secondary" disabled={busy || !consent} onClick={() => void save({ optedIn: true, consent })}>Autorizar marketing por e-mail</Button></div> : null}
        <p className="text-xs text-text-muted">O descadastro de marketing preserva as respostas humanas às conversas.</p>
      </div>
      <div className="space-y-2 border-t border-border pt-3 text-xs">
        <p className="font-medium">{segmentLabels[snapshot.segment]}</p>
        <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="flex items-center gap-1 text-text-muted"><Eye className="size-3" aria-hidden="true" />Total de aberturas</dt><dd className="mt-1 font-semibold">{snapshot.metrics.opens}</dd><dd className="mt-1 text-text-muted">Último e-mail aberto: {dateLabel(snapshot.metrics.lastOpenedAt)}</dd></div><div><dt className="flex items-center gap-1 text-text-muted"><MousePointerClick className="size-3" aria-hidden="true" />Total de cliques</dt><dd className="mt-1 font-semibold">{snapshot.metrics.clicks}</dd><dd className="mt-1 text-text-muted">Último clique: {dateLabel(snapshot.metrics.lastClickedAt)}</dd></div></dl>
      </div>
    </>}
  </section>
}
