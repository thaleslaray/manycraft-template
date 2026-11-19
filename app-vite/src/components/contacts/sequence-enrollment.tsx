import * as React from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { cancelContactSequence, enrollContacts, enrollmentLabel, listContactSequences, listSequences } from '@/data/sequences'
import { useAsync } from '@/hooks/use-async'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export function BulkSequenceDialog({ workspace, ids, onClose, onDone }: { workspace: string; ids: string[]; onClose: () => void; onDone: () => void }) {
  const catalog = useAsync(() => listSequences(workspace), workspace)
  const [sequence, setSequence] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  async function apply() {
    setBusy(true); setError('')
    try {
      const result = await enrollContacts(ids, sequence)
      toast.success(`${result.count} ${result.count === 1 ? 'contato inscrito' : 'contatos inscritos'} na sequência`)
      onDone()
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível inscrever os contatos.'); setBusy(false) }
  }
  return <Dialog open onOpenChange={open => !open && !busy && onClose()}><DialogContent>
    <DialogHeader><DialogTitle>Inscrever em sequência</DialogTitle><DialogDescription>{ids.length} {ids.length === 1 ? 'contato selecionado' : 'contatos selecionados'}. Quem já está nesta sequência mantém o progresso atual.</DialogDescription></DialogHeader>
    {catalog.error ? <div role="alert" className="space-y-2 text-sm"><p>Não foi possível carregar as sequências.</p><Button variant="secondary" onClick={catalog.reload}>Tentar de novo</Button></div> : catalog.loading ? <p role="status">Carregando sequências…</p> : !catalog.data?.length ? <p className="text-sm text-text-muted">Crie uma sequência em Automações para inscrever contatos.</p> : <div className="space-y-1">
      <Label htmlFor="bulk-sequence">Sequência</Label><Select value={sequence} onValueChange={setSequence} disabled={busy}><SelectTrigger id="bulk-sequence" className="w-full"><SelectValue placeholder="Escolha uma sequência" /></SelectTrigger><SelectContent>{catalog.data.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent></Select>
    </div>}
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    <DialogFooter><Button variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button><Button disabled={!sequence || catalog.loading || !!catalog.error} loading={busy} onClick={apply}>Inscrever</Button></DialogFooter>
  </DialogContent></Dialog>
}

export function ContactSequences({ contactId, workspace }: { contactId: string; workspace?: string }) {
  const subscriptions = useAsync(() => listContactSequences(contactId), contactId)
  const [busy, setBusy] = React.useState(false)
  const [enrolling, setEnrolling] = React.useState(false)
  async function cancel(sequenceId: string) {
    setBusy(true)
    try { await cancelContactSequence(contactId, sequenceId); subscriptions.reload(); toast.success('Sequência cancelada') }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível cancelar a sequência.') }
    finally { setBusy(false) }
  }
  return <section aria-label="Sequências do contato" className="space-y-2">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-base font-semibold">Inscrito nas sequências</h3>
      {workspace ? <Button size="sm" variant="link" className="h-auto p-0" onClick={() => setEnrolling(true)}>Assinar</Button> : null}
    </div>
    {enrolling && workspace ? <BulkSequenceDialog workspace={workspace} ids={[contactId]} onClose={() => setEnrolling(false)} onDone={() => { setEnrolling(false); subscriptions.reload() }} /> : null}
    {subscriptions.error ? <div role="alert" className="space-y-2 text-sm"><p>Não foi possível carregar as inscrições.</p><Button size="sm" variant="secondary" onClick={subscriptions.reload}>Tentar de novo</Button></div> : subscriptions.loading ? <p role="status" className="text-sm text-text-muted">Carregando inscrições…</p> : !subscriptions.data?.length ? <p className="text-sm text-text-muted">Nenhuma sequência inscrita.</p> : <ul className="space-y-1">
      {subscriptions.data.map(s => <li key={s.sequence_id} className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="break-words text-sm font-semibold">{s.name}</p><p className="text-xs text-text-muted">{enrollmentLabel(s)}</p>{s.connection_name ? <p className="break-words text-xs text-text-muted">{s.connection_name}</p> : null}</div><Button variant="ghost" size="icon" disabled={busy} aria-label={`Cancelar sequência ${s.name}`} onClick={() => cancel(s.sequence_id)}><X className="size-4" aria-hidden="true" /></Button></li>)}
    </ul>}
  </section>
}
