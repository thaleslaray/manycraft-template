import * as React from 'react'
import { EmailEventFields } from './email-event-fields'
import { EmailAutomationDialog } from './email-automation-dialog'
import { Link, useParams, useSearchParams } from 'react-router'
import { ArrowLeft, FileText, Monitor, Save, Send, Smartphone } from 'lucide-react'
import { toast } from 'sonner'
import { getEmailSettings, getEmailDrafts, saveEmailDraft, sendEmailTest, type EmailDesign, type EmailDraft } from '@/data/email'
import { useAsync } from '@/hooks/use-async'
import { Button } from '@/components/ui/button'
import { Input, field } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Banner } from '@/components/ui/banner'
import { Skeleton } from '@/components/ui/skeleton'

export function EmailDesignPage() {
  const { workspace } = useParams()
  const [query] = useSearchParams()
  // Quem veio de uma transmissão volta para ela; só caminhos internos de transmissões.
  const requested = query.get('voltar') ?? ''
  const back = workspace && requested.startsWith(`/${workspace}/broadcasts`) && !requested.startsWith('//') ? requested : ''
  const data = useAsync(async()=>({settings:await getEmailSettings(),drafts:await getEmailDrafts()}),'email-design')
  const frame = React.useRef<HTMLIFrameElement>(null)
  const current = React.useRef<EmailDraft | null>(null)
  const [content,setContent] = React.useState<{design:EmailDesign;html:string;text:string}|null>(null)
  const [senderId,setSenderId]=React.useState('')
  const [subject,setSubject]=React.useState('')
  const [preheader,setPreheader]=React.useState('')
  const [name,setName]=React.useState('Novo e-mail')
  const [recipient,setRecipient]=React.useState('')
  const [confirmed,setConfirmed]=React.useState(false)
  const [ready,setReady]=React.useState(false)
  const [busy,setBusy]=React.useState(false)
  const [error,setError]=React.useState('')
  const [preview,setPreview]=React.useState<'desktop'|'mobile'|null>(null)
  const [sent,setSent]=React.useState('')
  const [testContactId,setTestContactId]=React.useState<string|null>(null)
  const [savedId,setSavedId]=React.useState<string|null>(null)
  const [attach,setAttach]=React.useState(false)
  const [onOpen,setOnOpen]=React.useState<EmailDraft['onOpen']>(undefined)
  const [linkActions,setLinkActions]=React.useState<NonNullable<EmailDraft['linkActions']>>([])
  const snapshot=data.data ?? data.stale
  React.useEffect(()=>{const drafts=data.data?.drafts;if(!drafts)return;const chosen=drafts.find(draft=>draft.id === query.get('draft'));current.current=chosen ?? null;setSavedId(chosen?.id ?? null);setSenderId(chosen?.senderId ?? data.data?.settings.defaultSenderId ?? '');if(chosen){setOnOpen(chosen.onOpen);setLinkActions(chosen.linkActions ?? []);setName(chosen.name);setSubject(chosen.subject);setPreheader(chosen.preheader);setContent({design:chosen.design,html:chosen.html,text:chosen.text})}},[data.data,query])
  React.useEffect(()=>{function receive(event:MessageEvent){if(event.origin !== window.location.origin || event.source !== frame.current?.contentWindow || event.data?.source !== 'rea-email-studio')return;if(event.data.type === 'ready'){const css=getComputedStyle(document.documentElement);const theme=Object.fromEntries(['--color-bg','--color-surface','--color-text','--color-text-muted','--color-accent','--color-border'].map(key=>[key,css.getPropertyValue(key)]));frame.current?.contentWindow?.postMessage({source:'rea-email-panel',design:current.current?.design ?? null,theme},window.location.origin);setReady(true)}else if(event.data.type === 'change'){setContent({design:event.data.design,html:event.data.html,text:event.data.text});setError('')}else if(event.data.type === 'error')setError(event.data.message)}window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive)},[])
  async function run(action:()=>Promise<unknown>,message:string){setBusy(true);setError('');try{await action();toast.success(message)}catch(error){setError(error instanceof Error?error.message:'Não foi possível concluir.')}finally{setBusy(false)}}
  const payload = ():EmailDraft => {if(!content)throw new Error('Aguarde o editor preparar o design.');if(!senderId || !subject.trim() || !preheader.trim())throw new Error('Preencha remetente, assunto e prévia.');if(linkActions.some(link=>!/^https?:\/\//.test(link.url) || !link.actions?.length && !link.automationId))throw new Error('Preencha a URL e a ação de cada clique.');if(onOpen && !onOpen.automationId && !onOpen.actions?.length)throw new Error('Escolha uma automação ou tag para a abertura.');return {id:current.current?.id,name,senderId,subject,preheader,onOpen,linkActions,text:content.text,html:content.html,design:{...content.design,subject,subTitle:preheader}}}
  if(data.error && !snapshot)return <Banner variant="danger">Não foi possível abrir o editor.<Button variant="secondary" onClick={data.reload}>Tentar novamente</Button></Banner>
  if(!snapshot)return <Skeleton className="h-96"/>
  return <div className="min-w-0 space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><div>{back?<Link className="mb-1 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline" to={back}><ArrowLeft className="size-4"/>Voltar à transmissão</Link>:null}<Link className="flex items-center gap-1 text-sm text-text-muted hover:text-text" to={`/${workspace}/settings/email`}><ArrowLeft className="size-4"/>Configurações de e-mail</Link><h1 className="mt-2 text-xl font-bold">Criar e-mail</h1></div><Button loading={busy} disabled={!content} onClick={()=>void run(async()=>{const saved=await saveEmailDraft(payload());current.current=saved;setSavedId(saved.id ?? null)},'Rascunho salvo no espaço de trabalho.')}><Save className="size-4"/>Salvar rascunho</Button></header>
    {savedId && <Button variant="secondary" onClick={()=>setAttach(true)}>Usar em uma automação</Button>}
    <Banner className="bg-accent-soft">Design compilado para HTML neste navegador. Envios de teste e marketing são simulados; produção de marketing permanece bloqueada.</Banner>
    {error && <Banner variant="danger">{error}</Banner>}
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5"><div className="grid gap-4 lg:grid-cols-2"><div className="space-y-2"><Label htmlFor="draft-name">Nome do rascunho</Label><Input id="draft-name" value={name} onChange={event=>setName(event.target.value)}/></div><div className="space-y-2"><Label htmlFor="email-sender">Remetente</Label><select id="email-sender" className={`${field} h-10 w-full`} value={senderId} onChange={event=>setSenderId(event.target.value)}><option value="">Selecione um remetente</option>{snapshot.settings.senders.map(sender=><option key={sender.id} value={sender.id}>{sender.name} · {sender.address}</option>)}</select></div><div className="space-y-2"><Label htmlFor="email-subject">Assunto</Label><Input id="email-subject" required maxLength={200} value={subject} onChange={event=>setSubject(event.target.value)}/></div><div className="space-y-2"><Label htmlFor="email-preheader">Prévia</Label><Input id="email-preheader" required maxLength={200} value={preheader} onChange={event=>setPreheader(event.target.value)} placeholder="Texto que acompanha o assunto na caixa de entrada"/></div></div><p className="mt-3 text-xs text-text-muted">Variáveis: use {'{{first_name|Olá}}'} para definir uma reserva quando o campo estiver vazio.</p></section>
    <section className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3"><h2 className="font-semibold">Design da mensagem</h2><div className="flex gap-2"><Button size="sm" variant="secondary" disabled={!content} onClick={()=>setPreview('desktop')}><Monitor className="size-4"/>Computador</Button><Button size="sm" variant="secondary" disabled={!content} onClick={()=>setPreview('mobile')}><Smartphone className="size-4"/>Celular</Button></div></div><p className="border-b border-border px-4 py-2 text-xs text-text-muted">Arraste texto, imagem, botão ou divisor para o corpo. Imagens PNG e JPEG; GIF vira imagem estática.</p>{!ready && <p role="status" className="p-4 text-text-muted">Preparando editor…</p>}<div className="overflow-x-auto"><iframe ref={frame} title="Editor visual de e-mail" src="/email-studio/index.html" className="h-[680px] w-full min-w-[900px] border-0"/></div><p className="px-4 py-2 text-xs text-text-muted md:hidden">Deslize na horizontal para acessar os blocos e as opções do editor.</p></section>
    {preview && content && <section aria-label="Prévia do e-mail" className="rounded-lg border border-border bg-surface p-4"><div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-semibold">Prévia em {preview === 'mobile'?'celular':'computador'}</h2><Button size="sm" variant="ghost" onClick={()=>setPreview(null)}>Fechar prévia</Button></div><iframe sandbox="" title="Prévia segura do e-mail" srcDoc={content.html} className={`mx-auto h-96 max-w-full border border-border ${preview === 'mobile'?'w-[390px]':'w-full'}`}/></section>}
    <EmailEventFields onOpen={onOpen} links={linkActions} onChange={setOnOpen} onLinksChange={setLinkActions}/>
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5"><h2 className="font-semibold">Enviar um teste</h2><p className="mt-1 text-sm text-text-muted">O teste segue o mesmo caminho de um envio comum. Nenhuma mensagem sai deste ambiente local.</p><form className="mt-4 space-y-4" onSubmit={event=>{event.preventDefault();void run(async()=>{if(!confirmed)throw new Error('Confirme o transporte simulado.');const { name: _name, ...testContent }=payload();const result=await sendEmailTest({...testContent,to:recipient});setTestContactId(result.contactId ?? null);setSent(recipient)},'Teste registrado no transporte simulado.')}}><div className="max-w-lg space-y-2"><Label htmlFor="email-test-to">Destinatário de teste</Label><Input id="email-test-to" type="email" required value={recipient} onChange={event=>setRecipient(event.target.value)}/></div><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} className="mt-1"/><span>Confirmo que o teste usa apenas o transporte simulado local.</span></label><Button type="submit" disabled={!confirmed || snapshot.settings.usage.paused || !content} loading={busy}><Send className="size-4"/>Enviar teste</Button>{sent && <p role="status" className="text-sm text-success">Teste simulado registrado para {sent}.</p>}{testContactId && <Link className="block text-sm font-medium text-accent underline" to={`/${workspace}/contacts/${encodeURIComponent(testContactId)}/email`}>Ver perfil de e-mail do contato de teste</Link>}</form></section>
    {attach && savedId && <EmailAutomationDialog draftId={savedId} onClose={()=>setAttach(false)}/>}
    {snapshot.drafts.length > 0 && <section className="space-y-3"><h2 className="font-semibold">Rascunhos salvos</h2><ul className="divide-y divide-border rounded-lg border border-border bg-surface">{snapshot.drafts.map(draft=><li key={draft.id} className="p-4"><Link to={`/${workspace}/settings/email/design?draft=${encodeURIComponent(draft.id ?? '')}`} reloadDocument className="inline-flex items-center gap-2 font-medium"><FileText className="size-4"/>{draft.name}</Link><p className="mt-1 text-xs text-text-muted">{draft.subject}</p></li>)}</ul></section>}
  </div>
}
