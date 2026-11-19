import * as React from 'react'
import { GitMerge, Pause, UserMinus } from 'lucide-react'
import { toast } from 'sonner'
import { listContacts, listFields, type ContactDetail, type ContactPage } from '@/data'
import { bulkContactAction, exportContact, exportContactsCsv, mergeContacts, previewContactMerge, type ContactExportInput, type MergePreview } from '@/data/contact-portability'
import { useAsync } from '@/hooks/use-async'
import { Banner } from '@/components/ui/banner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { contactName } from './contact-name'

export function BulkContactStatusDialog({ action, ids, onClose, onDone }: {
  action: 'pause' | 'unsubscribe'; ids: string[]; onClose: () => void; onDone: () => void
}) {
  const [word, setWord] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const inputId = React.useId()
  const pause = action === 'pause'
  const required = pause ? 'PAUSAR' : 'DESCADASTRAR'
  const validCount = ids.length > 0 && ids.length <= 100
  const allowed = validCount && word === required && !busy
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto" onEscapeKeyDown={e => { if (busy) e.preventDefault() }} onInteractOutside={e => { if (busy) e.preventDefault() }}>
      <form className="space-y-4" aria-busy={busy} onSubmit={async e => {
        e.preventDefault()
        if (!allowed) return
        setBusy(true); setError('')
        try {
          await bulkContactAction(action, ids, word)
          toast.success(pause ? 'Automações pausadas para os contatos selecionados.' : 'Contatos selecionados descadastrados.')
          onDone()
        } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a ação.'); setBusy(false) }
      }}>
        <DialogHeader><DialogTitle className="flex items-center gap-2">{pause ? <Pause className="size-5" aria-hidden="true" /> : <UserMinus className="size-5" aria-hidden="true" />}{pause ? 'Pausar automações em lote' : 'Descadastrar contatos em lote'}</DialogTitle><DialogDescription>{ids.length} {ids.length === 1 ? 'contato selecionado' : 'contatos selecionados'}.</DialogDescription></DialogHeader>
        <p className="text-sm">{pause ? 'As automações ficarão pausadas até serem retomadas no perfil de cada contato. Os dados e as inscrições serão mantidos.' : 'O recebimento de mensagens será desautorizado em todas as conexões destes contatos. Os dados continuarão disponíveis. Uma nova autorização será necessária para voltar a receber.'}</p>
        {!validCount && <Banner variant="danger">Selecione de 1 a 100 contatos por vez.</Banner>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="space-y-2"><Label htmlFor={inputId}>Digite {required} para confirmar</Label><Input id={inputId} autoComplete="off" spellCheck={false} value={word} disabled={busy} onChange={e => setWord(e.target.value)} /></div>
        <DialogFooter className="flex-wrap"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Voltar</Button><Button type="submit" variant={pause ? 'primary' : 'danger'} disabled={!allowed} loading={busy}>Confirmar</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

/** Baixa o CSV dos contatos escolhidos ou do filtro atual; avisa quantos saíram ou por que não deu. */
export async function downloadContactsCsv(input: ContactExportInput) {
  const loading = toast.loading('Preparando o arquivo…')
  try {
    const { csv, count, file_name } = await exportContactsCsv(input)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = file_name
    document.body.appendChild(anchor); anchor.click(); anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast.success(`${count} ${count === 1 ? 'contato exportado' : 'contatos exportados'}.`, { id: loading })
  } catch (cause) { toast.error(cause instanceof Error ? cause.message : 'Não foi possível exportar os contatos.', { id: loading }) }
}

/** Baixa o JSON com os dados do contato (portabilidade); avisa se não der. */
export async function downloadContactData(contactId: string) {
  try {
    const data = await exportContact(contactId)
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = `contato-${contactId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
    document.body.appendChild(anchor); anchor.click(); anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (cause) { toast.error(cause instanceof Error ? cause.message : 'Não foi possível baixar os dados.') }
}

export function MergeContactDialog({ primary, workspace, onClose, onDone }: {
  primary: ContactDetail; workspace: string; onClose: () => void; onDone: () => void
}) {
  const [search, setSearch] = React.useState('')
  const q = React.useDeferredValue(search)
  const candidates = useAsync(() => q.trim() ? listContacts(workspace, null, { search: q }) : Promise.resolve(null), `${workspace}|${q}`)
  const [extra, setExtra] = React.useState<{ key: string; page: ContactPage } | null>(null)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const more = extra?.key === q ? extra.page : null
  const rows = [...(candidates.data?.rows ?? []), ...(more?.rows ?? [])]
  const nextCursor = more ? more.next_cursor : candidates.data?.next_cursor
  const [preview, setPreview] = React.useState<MergePreview | null>(null)
  const [word, setWord] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const fields = useAsync(() => listFields(workspace), workspace)
  const fieldNames = Object.fromEntries((fields.data ?? []).map(field => [field.id, field.name]))
  const searchId = React.useId(), wordId = React.useId()
  async function compare(id: string) {
    setBusy(true); setError(''); setPreview(null); setWord('')
    try { setPreview(await previewContactMerge(primary.contact.id, id)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível comparar os contatos.') }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="max-h-[90dvh] overflow-y-auto" onEscapeKeyDown={e => { if (busy) e.preventDefault() }} onInteractOutside={e => { if (busy) e.preventDefault() }}>
    <DialogHeader><DialogTitle className="flex items-center gap-2"><GitMerge className="size-5" aria-hidden="true" />Mesclar contatos</DialogTitle><DialogDescription>Escolha o contato duplicado e compare os dados antes de confirmar.</DialogDescription></DialogHeader>
    <div className="space-y-2"><Label htmlFor={searchId}>Buscar contato para mesclar</Label><Input id={searchId} value={search} disabled={busy} placeholder="Nome do contato duplicado" onChange={e => { setSearch(e.target.value); setPreview(null); setWord(''); setError('') }} /></div>
    {candidates.error ? <Banner variant="danger">Não foi possível buscar contatos.<Button size="sm" variant="link" onClick={candidates.reload}>Tentar novamente</Button></Banner> : candidates.loading && q.trim() ? <p role="status" className="text-sm text-text-muted">Buscando contatos…</p> : q.trim() && !preview ? <div className="max-h-40 space-y-1 overflow-y-auto">{rows.filter(c => c.id !== primary.contact.id).map(c => <Button key={c.id} variant="secondary" className="h-auto w-full justify-start whitespace-normal text-left" disabled={busy} onClick={() => compare(c.id)}>{contactName(c)}</Button>)}{nextCursor && <Button className="w-full" variant="ghost" loading={loadingMore} disabled={busy} onClick={async () => {
      setLoadingMore(true); setError('')
      try {
        const page = await listContacts(workspace, nextCursor, { search: q })
        setExtra({ key: q, page: { ...page, rows: [...(more?.rows ?? []), ...page.rows] } })
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível carregar mais contatos.') }
      finally { setLoadingMore(false) }
    }}>Carregar mais contatos</Button>}{rows.filter(c => c.id !== primary.contact.id).length === 0 && <p className="text-sm text-text-muted">Nenhum outro contato encontrado.</p>}</div> : null}
    {preview && <>
      <section aria-label="Comparação dos contatos" className="grid min-w-0 grid-cols-2 gap-3"><ContactComparison fieldNames={fieldNames} detail={preview.primary} label="Principal · permanece" /><ContactComparison fieldNames={fieldNames} detail={preview.secondary} label="Duplicado · será unido" /></section>
      {preview.can_merge ? <p className="text-sm text-text-muted">Os dados preenchidos do principal prevalecem. Dados ausentes, tags, conexões e conversas do duplicado serão incorporados. Pausas e descadastros serão preservados. As automações em andamento do duplicado serão canceladas. A mescla não pode ser desfeita.</p> : <Banner variant="danger"><p>Não é possível mesclar duas identidades do mesmo canal, mesmo em conexões diferentes.</p><ul className="mt-2 space-y-1 text-sm">{preview.conflicts.map((conflict, i) => <li key={i}>{conflict.primary_connection_name || 'Conexão do principal'} e {conflict.secondary_connection_name || 'Conexão do duplicado'}</li>)}</ul></Banner>}
      {preview.can_merge && <div className="space-y-2"><Label htmlFor={wordId}>Digite MESCLAR para confirmar</Label><Input id={wordId} autoComplete="off" spellCheck={false} value={word} disabled={busy} onChange={e => setWord(e.target.value)} /></div>}
    </>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <DialogFooter className="flex-wrap"><Button variant="secondary" disabled={busy} onClick={onClose}>Voltar</Button><Button disabled={!preview?.can_merge || word !== 'MESCLAR' || busy} loading={busy} onClick={async () => {
      if (!preview?.can_merge || word !== 'MESCLAR' || busy) return
      setBusy(true); setError('')
      try { await mergeContacts(primary.contact.id, preview.secondary.contact.id, word); toast.success('Contatos mesclados.'); onDone() }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível mesclar os contatos.'); setBusy(false) }
    }}>Confirmar mescla</Button></DialogFooter>
  </DialogContent></Dialog>
}

function ContactComparison({ detail, label, fieldNames }: { detail: ContactDetail; label: string; fieldNames: Record<string, string> }) {
  return <div className="min-w-0 space-y-2 rounded-md border border-border p-3 text-sm"><h3 className="font-semibold">{label}</h3><p className="break-words font-medium">{contactName(detail.contact)}</p><dl className="space-y-2 break-words">
    <div><dt className="text-xs text-text-muted">ID</dt><dd className="break-all">{detail.contact.id}</dd></div>
    <div><dt className="text-xs text-text-muted">Status</dt><dd>{detail.contact.status === 'subscribed' ? 'Inscrito' : 'Descadastrado'}</dd></div>
    <div><dt className="text-xs text-text-muted">Automações</dt><dd>{detail.contact.automation_paused_until && Date.parse(detail.contact.automation_paused_until) > Date.now() ? "Pausadas" : "Sem pausa"}</dd></div>
    <div><dt className="text-xs text-text-muted">Conexões</dt><dd>{detail.channels.map(c => c.connection_name || c.channel_id).join(', ') || 'Nenhuma'}</dd></div>
    <div><dt className="text-xs text-text-muted">Tags</dt><dd>{detail.tags.map(t => t.name).join(', ') || 'Sem tags'}</dd></div>
    {[['E-mail', detail.contact.email], ['Telefone', detail.contact.phone], ['Idioma', detail.contact.locale], ['Fuso', detail.contact.timezone]].map(([name, value]) => <div key={name}><dt className="text-xs text-text-muted">{name}</dt><dd>{value || 'Não informado'}</dd></div>)}
    {detail.field_values.map(field => <div key={field.field_id}><dt className="text-xs text-text-muted">{fieldNames[field.field_id] ?? field.field_id}</dt><dd>{typeof field.value === 'object' ? JSON.stringify(field.value) : String(field.value ?? 'Não informado')}</dd></div>)}
  </dl></div>
}
