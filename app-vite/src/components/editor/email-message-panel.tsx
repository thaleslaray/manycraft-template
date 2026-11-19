import * as React from 'react'
import { FilePenLine, Send } from 'lucide-react'
import { getEmailDrafts, getEmailSettings, sendEmailTest, type EmailDesign, type EmailDraft } from '@/data/email'
import type { Connection } from '@/data/connections'
import { useAsync } from '@/hooks/use-async'
import { Banner } from '@/components/ui/banner'
import { Button } from '@/components/ui/button'
import { Input, field } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SidePanel } from '@/components/ui/side-panel'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { EmailEventFields } from '@/components/email/email-event-fields'
import { NodeErrors, NodeLinks, type PanelProps } from './panel-shared'

type EmailNode = Omit<EmailDraft, 'id' | 'name' | 'design'> & { design?: EmailDesign }
export function EmailMessagePanel({ p, capability }: { p: PanelProps; capability: NonNullable<Connection['profile']>['email'] }) {
  const settings=useAsync(getEmailSettings,'editor-email-settings')
  const email=(p.node.data.config.email ?? {}) as Partial<EmailNode>
  const legacy=useAsync(()=>email.html && !email.design ? getEmailDrafts() : Promise.resolve([]),`legacy-email-design:${p.node.id}:${!!email.html && !email.design}`)
  const storedDesign=email.design ?? legacy.data?.find(draft=>draft.html === email.html)?.design
  const [designOpen,setDesignOpen]=React.useState(false)
  const [to,setTo]=React.useState(''), [confirmed,setConfirmed]=React.useState(false)
  const [busy,setBusy]=React.useState(false), [result,setResult]=React.useState(''), [error,setError]=React.useState('')
  const senderId=email.senderId ?? settings.data?.defaultSenderId ?? ''
  function update(patch: Partial<EmailNode>) { p.updateConfig({email:{...email,senderId,...patch}}) }
  const sender=settings.data?.senders.find(sender=>sender.id===senderId)
  return <SidePanel title="Mensagem de e-mail" tone="message" onClose={p.onClose}>
    <NodeErrors errors={p.errors} show={p.showErrors}/>
    {settings.error && <Banner variant="danger">Não foi possível carregar os remetentes.<Button variant="secondary" size="sm" onClick={settings.reload}>Tentar novamente</Button></Banner>}
    <div className="space-y-2"><Label htmlFor="node-email-sender">Remetente</Label><select id="node-email-sender" className={`${field} h-10 w-full`} value={senderId} disabled={p.readOnly || !settings.data} onChange={event=>update({senderId:event.target.value})}><option value="">Selecione um remetente</option>{settings.data?.senders.map(sender=><option key={sender.id} value={sender.id}>{sender.name} · {sender.address}</option>)}</select>{sender && <p className="break-words text-xs text-text-muted">Respostas para {sender.replyTo || sender.address}</p>}</div>
    <div className="space-y-2"><Label htmlFor="node-email-subject">Assunto</Label><Input id="node-email-subject" maxLength={capability?.subjectMaxLength ?? 998} required value={email.subject ?? ''} disabled={p.readOnly} onChange={event=>update({subject:event.target.value})}/></div>
    {capability?.preheader && <div className="space-y-2"><Label htmlFor="node-email-preheader">Prévia</Label><Input id="node-email-preheader" required maxLength={1000} value={email.preheader ?? ''} disabled={p.readOnly} onChange={event=>update({preheader:event.target.value})} placeholder="Complemento do assunto na caixa de entrada"/></div>}
    <section className="space-y-3 rounded-lg border border-border p-3"><h3 className="font-semibold">Design da mensagem</h3>{email.html?<p aria-label="Resumo do design do passo" className="line-clamp-6 whitespace-pre-wrap break-words rounded-md bg-surface-muted p-3 text-sm">{email.text}</p>:<p className="text-sm text-text-muted">Monte o corpo com texto, imagens e botões com link.</p>}{email.html && !storedDesign && !legacy.loading && <p className="text-xs text-text-muted">O HTML anterior será preservado até você aplicar um novo design.</p>}<Button variant="secondary" className="w-full" disabled={p.readOnly || !capability?.html || legacy.loading} onClick={()=>setDesignOpen(true)}><FilePenLine className="size-4"/>{email.html && !storedDesign ? "Criar novo design" : "Editar design"}</Button></section>
    <fieldset disabled={p.readOnly} className="min-w-0"><EmailEventFields onOpen={email.onOpen} links={email.linkActions ?? []} onChange={onOpen=>update({onOpen})} onLinksChange={linkActions=>update({linkActions})}/></fieldset>
    <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-semibold">Enviar teste simulado</summary><form className="mt-3 space-y-3" onSubmit={async event=>{event.preventDefault();setError('');setResult('');if(!email.subject?.trim() || !email.preheader?.trim() || !email.html || !email.text){setError('Preencha assunto, prévia e design antes do teste.');return}setBusy(true);try{await sendEmailTest({...email as EmailNode,design:email.design ?? {subject:email.subject,subTitle:email.preheader,content:{}},senderId,to});setResult(`Teste simulado registrado para ${to}.`)}catch(error){setError(error instanceof Error?error.message:'Não foi possível enviar o teste.')}finally{setBusy(false)}}}><Label htmlFor="node-email-to">Destinatário de teste</Label><Input id="node-email-to" type="email" required value={to} disabled={p.readOnly} onChange={event=>setTo(event.target.value)}/><label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={confirmed} disabled={p.readOnly} onChange={event=>setConfirmed(event.target.checked)}/><span>Usar somente o transporte simulado local.</span></label><Button size="sm" type="submit" disabled={p.readOnly || !confirmed || !email.html || settings.data?.usage.paused} loading={busy}><Send className="size-4"/>Enviar teste</Button>{error && <Banner variant="danger">{error}</Banner>}{result && <p role="status" className="text-xs text-success">{result}</p>}</form></details>
    <p className="text-xs text-text-muted">O próximo passo continua após o envio. Aberturas e cliques executam suas ações separadamente.</p>
    <NodeLinks p={p}/>
    {designOpen && <EmailNodeDesign design={storedDesign} onClose={()=>setDesignOpen(false)} onApply={content=>{const text=content.text.trim();p.updateConfig({email:{...email,senderId,...content},blocks:[{kind:'text',text:text.slice(0,1000) || 'E-mail'}]});setDesignOpen(false)}}/>}
  </SidePanel>
}

function EmailNodeDesign({design,onClose,onApply}:{design?:EmailDesign;onClose:()=>void;onApply:(content:{design:EmailDesign;html:string;text:string})=>void}) {
  const frame=React.useRef<HTMLIFrameElement>(null)
  const [content,setContent]=React.useState<{design:EmailDesign;html:string;text:string}|null>(null)
  const [error,setError]=React.useState('')
  React.useEffect(()=>{function receive(event:MessageEvent){if(event.origin!==window.location.origin || event.source!==frame.current?.contentWindow || event.data?.source!=='rea-email-studio')return;if(event.data.type==='ready'){const css=getComputedStyle(document.documentElement);const theme=Object.fromEntries(['--color-bg','--color-surface','--color-text','--color-text-muted','--color-accent','--color-border'].map(key=>[key,css.getPropertyValue(key)]));frame.current?.contentWindow?.postMessage({source:'rea-email-panel',design,theme},window.location.origin)}else if(event.data.type==='change'){setContent({design:event.data.design,html:event.data.html,text:event.data.text});setError('')}else if(event.data.type==='error')setError(event.data.message)}window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive)},[design])
  return <Dialog open onOpenChange={open=>!open && onClose()}><DialogContent className="max-w-none w-[calc(100%-2rem)] h-[calc(100dvh-2rem)] grid-rows-[auto_1fr_auto] p-4"><DialogHeader><DialogTitle>Design do e-mail</DialogTitle><DialogDescription>Edite o corpo da mensagem e aplique ao passo atual.</DialogDescription></DialogHeader>{error && <Banner variant="danger">{error}</Banner>}<div className="min-h-0 overflow-auto"><iframe ref={frame} title="Editor visual de e-mail" src="/email-studio/index.html" className="h-full min-h-[500px] w-full min-w-[900px] border-0"/></div><div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button disabled={!content || !!error} onClick={()=>content && onApply(content)}>Aplicar design</Button></div></DialogContent></Dialog>
}
