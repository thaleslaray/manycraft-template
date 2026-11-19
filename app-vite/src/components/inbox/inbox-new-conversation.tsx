import * as React from "react"
import { Link } from "react-router"
import { getConnectionCatalog, listConnections, startInboxConversation, type Connection } from "@/data"
import { useAsync } from "@/hooks/use-async"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input, Textarea, field } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { InboxTemplateDialog } from "./inbox-template-dialog"

/** "+55 (11) 99999-0001" -> digits; the same rule the server applies (country code first, 8 to 15 digits). */
const digitsOf = (value: string) => value.replace(/[\s().+-]/g, "")
const validPhone = (value: string) => /^[1-9]\d{7,14}$/.test(digitsOf(value))

/** What the connection's ficha says about opening a conversation: an approved template, or free text with the operator's word that the person opted in. */
const startMode = (row: Connection) => row.status !== "connected" ? null
  : row.profile?.initiator === "business_with_template" ? "template" as const
  : row.profile?.initiator === "business_with_optin" && row.profile.identity?.key === "phone_e164" ? "text" as const : null
export function InboxNewConversation({ workspace, onClose, onStarted }: { workspace: string; onClose: () => void; onStarted: (conversationId: string) => void }) {
  const connections = useAsync(() => listConnections(workspace), workspace)
  const list = connections.data ?? connections.stale   // não desmonta o diálogo se a lista recarregar
  const official = list?.filter(row => startMode(row)) ?? []
  const catalog = useAsync(() => getConnectionCatalog(), "catalog")
  const [picked, setPicked] = React.useState("")
  const [phone, setPhone] = React.useState("")
  const [name, setName] = React.useState("")
  const [consent, setConsent] = React.useState(false)
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const chosen = official.find(row => row.id === picked) ?? official[0]
  const connectionId = chosen?.id
  const mode = chosen ? startMode(chosen) : null
  const notice = catalog.data?.channels.flatMap(channel => channel.providers).find(provider => provider.id === chosen?.provider)?.notice
  if (!list || !connectionId) return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent>
    <DialogHeader><DialogTitle>Nova conversa</DialogTitle><DialogDescription>Comece uma conversa com um número que ainda não escreveu para você.</DialogDescription></DialogHeader>
    {connections.error ? <Banner variant="danger">Não foi possível carregar as conexões.</Banner> : !list ? <p role="status">Carregando conexões…</p>
      : <div className="space-y-3 text-sm">
        <Banner>Aqui só dá para puxar assunto por WhatsApp, e você não tem um número de WhatsApp conectado e ativo. Telegram, Instagram, Messenger e e-mail só abrem conversa quando a própria pessoa escreve primeiro.</Banner>
        <p>Para conversar com alguém que já é seu contato, abra o perfil dele em <Link className="font-semibold text-accent underline underline-offset-2" to={`/${encodeURIComponent(workspace)}/contacts`} onClick={onClose}>Contatos</Link>. Para começar uma conversa nova, <Link className="font-semibold text-accent underline underline-offset-2" to={`/${encodeURIComponent(workspace)}/settings/channels`} onClick={onClose}>conecte um número de WhatsApp</Link>.</p>
      </div>}
    <DialogFooter><Button type="button" variant="secondary" onClick={onClose}>Fechar</Button></DialogFooter>
  </DialogContent></Dialog>
  const phoneError = phone.trim() !== "" && !validPhone(phone)
  const shared = <div className="space-y-4">
      {official.length > 1 && <div className="space-y-1"><Label htmlFor="new-conversation-connection">Número que envia</Label>
        <select id="new-conversation-connection" className={`${field} h-10`} value={connectionId} onChange={event => setPicked(event.target.value)}>
          {official.map(row => <option key={row.id} value={row.id}>{row.displayName || row.label}</option>)}</select></div>}
      <div className="space-y-1"><Label htmlFor="new-conversation-phone">Telefone com código do país e DDD</Label>
        <Input id="new-conversation-phone" type="tel" inputMode="tel" autoComplete="off" placeholder="+55 11 99999-0001" value={phone} onChange={event => setPhone(event.target.value)} aria-invalid={phoneError} aria-describedby={phoneError ? "new-conversation-phone-error" : undefined} />
        {phoneError && <p id="new-conversation-phone-error" className="text-xs text-danger">Use o número completo, por exemplo +55 11 99999-0001.</p>}</div>
      <div className="space-y-1"><Label htmlFor="new-conversation-name">Nome <span className="font-normal text-text-muted">(opcional)</span></Label>
        <Input id="new-conversation-name" maxLength={120} value={name} onChange={event => setName(event.target.value)} /></div>
      <label className="flex cursor-pointer items-start gap-2 text-sm"><input type="checkbox" className="mt-1 size-4 accent-accent" checked={consent} onChange={event => setConsent(event.target.checked)} />
        <span>Confirmo que esta pessoa aceitou receber mensagens da empresa por WhatsApp.</span></label>
    </div>
  const payload = { connection_id: connectionId, phone: phone.trim(), ...(name.trim() ? { name: name.trim() } : {}), consent: true as const }
  if (mode === "text") return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
    <DialogHeader><DialogTitle>Nova conversa</DialogTitle><DialogDescription>Informe o telefone, escreva a primeira mensagem e confirme que a pessoa aceitou receber contato.</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={async event => {
      event.preventDefault()
      if (!validPhone(phone) || !consent || !text.trim() || busy) return
      setBusy(true); setError(null)
      try { const result = await startInboxConversation({ ...payload, text: text.trim() }); onStarted(result.conversation.id) }
      catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível iniciar a conversa.") }
      finally { setBusy(false) }
    }}>
      {notice && <Banner variant="warning">{notice}</Banner>}
      {shared}
      <div className="space-y-1"><Label htmlFor="new-conversation-text">Primeira mensagem</Label>
        <Textarea id="new-conversation-text" rows={4} maxLength={4096} value={text} disabled={busy} onChange={event => setText(event.target.value)} /></div>
      {error && <Banner variant="danger">{error}</Banner>}
      <DialogFooter><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button>
        <Button type="submit" loading={busy} disabled={!validPhone(phone) || !consent || !text.trim()}>Enviar mensagem</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>
  return <InboxTemplateDialog connectionId={connectionId} busy={busy} onClose={onClose} title="Nova conversa"
    emptyHelp={<>Para começar a conversa você precisa de um modelo aprovado pela Meta. <Link className="font-semibold text-accent underline underline-offset-2" to={`/${encodeURIComponent(workspace)}/settings/message-templates`} onClick={onClose}>Crie ou atualize seus modelos</Link> e volte aqui.</>}
    description="O WhatsApp só deixa a empresa puxar assunto com um modelo aprovado. Informe o telefone, escolha o modelo e confirme que a pessoa aceitou receber mensagens."
    blocked={!validPhone(phone) || !consent}
    fields={shared}
    onSend={async template => {
      setBusy(true)
      try { const result = await startInboxConversation({ ...payload, template }); onStarted(result.conversation.id) }
      finally { setBusy(false) }
    }} />
}
