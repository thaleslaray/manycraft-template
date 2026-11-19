import * as React from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { isFakeMode } from '@/data/api'
import { getInboxContext, getInboxSettings, saveInboxSettings, listSavedReplies, saveSavedReply, deleteSavedReply, type SavedReply } from '@/data/inbox-team'
import { useAsync } from '@/hooks/use-async'
import { useFormKey } from '@/hooks/use-draft'
import { settingsKeys } from '@/data/screen-keys'
import { useParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Banner } from '@/components/ui/banner'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { InboxLabelsSettings } from './inbox-labels-settings'
import { SettingsRow, SettingsRows } from './settings-rows'

const behaviors = [
  { id: 'any_message', label: 'Qualquer mensagem inicia uma conversa' },
  { id: 'explicit', label: 'A conversa só abre por ação da equipe' },
] as const

export const loadInboxSettings = async () => ({ settings: await getInboxSettings(), replies: await listSavedReplies(), editable: isFakeMode() || (await getInboxContext()).can_configure })

/** Configurações > Comportamento da caixa de entrada: como a conversa abre, a pausa das automações e as respostas prontas. */
export function InboxSettingsPanel() {
  const { workspace = '' } = useParams()
  const data = useAsync(loadInboxSettings, 'inbox-settings', { cache: settingsKeys.inbox(workspace) })
  const [editing, setEditing] = React.useState<SavedReply | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [error, setError] = React.useState('')
  const snapshot = data.data ?? data.stale
  // O formulário nasce do dado (às vezes do cache) e remonta com a revalidação só enquanto ninguém mexeu nele.
  const behavior = useFormKey(JSON.stringify(snapshot?.settings ?? null))
  async function run(task: () => Promise<unknown>, success: string) {
    setBusy(true); setError(''); setMessage('')
    try { await task(); setMessage(success); data.reload(); return true }
    catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível salvar.'); return false }
    finally { setBusy(false) }
  }
  if (data.error) return <Banner variant="danger">Não foi possível carregar a caixa de entrada. <Button onClick={data.reload}>Tentar de novo</Button></Banner>
  if (!snapshot) return <p role="status">Carregando preferências…</p>
  return <section className="min-w-0 space-y-6" aria-label="Configurações da caixa de entrada">
    <h2 className="sr-only">Caixa de entrada</h2>
    {error && <Banner variant="danger">{error}</Banner>}
    {message && <p role="status" className="text-sm text-success">{message}</p>}
    {!snapshot.editable && <Banner>Seu papel permite consultar estas preferências.</Banner>}
    <SettingsRows label="Comportamento da caixa de entrada">
      <form key={behavior.key} onChange={behavior.touch} onSubmit={event => {
        event.preventDefault(); const form = new FormData(event.currentTarget)
        void run(() => saveInboxSettings({ pause_minutes: Number(form.get('pause')), new_message_behavior: form.get('behavior') as 'any_message' | 'explicit' }), 'Comportamento salvo.').then(ok => { if (ok) behavior.release() })
      }}>
        <fieldset disabled={busy || !snapshot.editable} className="min-w-0">
          <SettingsRow label="Comportamento da caixa de entrada" help="A abertura automática coloca novas conversas sem responsável. A abertura manual mantém o estado atual até alguém iniciar o atendimento.">
            <div role="radiogroup" aria-label="Quando chega uma nova mensagem" className="space-y-2">
              {behaviors.map(item => <label key={item.id} className="flex items-center gap-2 text-sm"><input type="radio" name="behavior" value={item.id} defaultChecked={snapshot.settings.new_message_behavior === item.id} className="size-4 accent-accent" />{item.label}</label>)}
            </div>
          </SettingsRow>
          <SettingsRow label="Suspender automações enquanto houver conversas" htmlFor="inbox-pause" help="De 0 a 1.440 minutos. Durante a pausa depois de uma resposta humana, as automações aguardam para voltar a responder.">
            <div className="flex gap-2"><Input id="inbox-pause" name="pause" type="number" min={0} max={1440} required defaultValue={snapshot.settings.pause_minutes} /><Button type="submit" loading={busy}>Salvar comportamento</Button></div>
          </SettingsRow>
        </fieldset>
      </form>
      <SettingsRow label="Resposta pronta" className="lg:grid-cols-[minmax(0,0.73fr)_minmax(0,2.27fr)]">
        <div className="max-w-4xl space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-text-muted">Digite / na resposta para buscar um texto compartilhado com a equipe.</p>
            {snapshot.editable ? <Button type="button" disabled={busy} onClick={() => setEditing({ id: '', shortcut: '', body: '' })}><Plus aria-hidden="true" className="size-4" />Nova resposta pronta</Button> : null}</div>
          <div className="overflow-hidden rounded-md border border-border">
            <div className="grid grid-cols-[minmax(0,0.6fr)_minmax(0,1.4fr)_5rem] gap-3 border-b border-border px-4 py-3 text-sm font-semibold"><span>Atalho</span><span>Mensagem completa</span><span /></div>
            {snapshot.replies.length ? <ul className="divide-y divide-border">{snapshot.replies.map(reply => <li key={reply.id} className="grid grid-cols-[minmax(0,0.6fr)_minmax(0,1.4fr)_5rem] items-start gap-3 px-4 py-3">
              <p className="text-sm wrap-anywhere">/{reply.shortcut}</p>
              <p className="whitespace-pre-wrap text-sm text-text-muted wrap-anywhere">{reply.body}</p>
              {snapshot.editable ? <span className="flex justify-end"><Button variant="ghost" size="sm" aria-label={`Editar /${reply.shortcut}`} disabled={busy} onClick={() => setEditing(reply)}><Pencil className="size-4" /></Button><Button variant="ghost" size="sm" aria-label={`Excluir /${reply.shortcut}`} disabled={busy} onClick={() => void run(() => deleteSavedReply(reply.id), 'Resposta removida.')}><Trash2 className="size-4" /></Button></span> : <span />}
            </li>)}</ul> : <p className="px-4 py-3 text-sm text-text-muted">Nenhuma resposta pronta ainda.</p>}
          </div>
        </div>
      </SettingsRow>
    </SettingsRows>
    {editing && <Dialog open onOpenChange={open => !open && setEditing(null)}><DialogContent>
      <DialogHeader><DialogTitle>{editing.id ? 'Editar resposta pronta' : 'Nova resposta pronta'}</DialogTitle><DialogDescription>Digite / na resposta de uma conversa para buscar este texto.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={async event => {
        event.preventDefault(); const form = new FormData(event.currentTarget)
        if (await run(() => saveSavedReply({ shortcut: String(form.get('shortcut')), body: String(form.get('body')) }, editing.id || undefined), 'Resposta salva.')) setEditing(null)
      }}>
        <div className="space-y-2"><Label htmlFor="reply-shortcut">Atalho</Label><Input id="reply-shortcut" name="shortcut" required maxLength={80} defaultValue={editing.shortcut} placeholder="boas_vindas" /></div>
        <div className="space-y-2"><Label htmlFor="reply-body">Texto da resposta</Label><Textarea id="reply-body" name="body" required maxLength={4000} defaultValue={editing.body} /></div>
        <DialogFooter><Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancelar</Button><Button type="submit" loading={busy}>{editing.id ? 'Salvar resposta' : 'Criar resposta salva'}</Button></DialogFooter>
      </form></DialogContent></Dialog>}
    <InboxLabelsSettings />
  </section>
}
