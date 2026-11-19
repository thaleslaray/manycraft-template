import { apiRequest, isFakeMode } from "@/data/api"
import * as React from 'react'
import { EmailMetricsPanel } from './email-metrics'
import { EmailStopSettings } from './email-stop-settings'
import { Link, useParams } from 'react-router'
import { CheckCircle2, Copy, Plus, ShieldCheck, Star } from 'lucide-react'
import { toast } from 'sonner'
import { emailPauseNotice, getEmailSettings, saveEmailSender, updateEmailSettings, verifyEmailSender, type EmailSender, type EmailSettings } from '@/data/email'
import { useAsync } from '@/hooks/use-async'
import { useFormKey } from '@/hooks/use-draft'
import { settingsKeys } from '@/data/screen-keys'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Banner } from '@/components/ui/banner'
import { Skeleton } from '@/components/ui/skeleton'
import { SettingsRow, SettingsRows } from '@/components/settings/settings-rows'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const statusLabels: Record<string, string> = { verified: 'Verificado', connected: 'Pronto para enviar', pending: 'Verificação pendente', unverified: 'Confirme o endereço', dns_pending: 'Aguardando DNS', expired: 'Verificação expirada', failed: 'Falha na verificação' }
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Não foi possível salvar.'
export function EmailSettingsPanel() {
  const { workspace } = useParams()
  // Remetentes, empresa e uso: nada secreto (a chave do Resend nunca volta do motor).
  const data = useAsync(getEmailSettings, 'email-settings', { cache: settingsKeys.email(workspace ?? '') })
  const snapshot = data.data ?? data.stale
  const [editor, setEditor] = React.useState<EmailSender | 'new' | null>(null)
  // Os diálogos nascem do dado (às vezes do cache) e remontam com a revalidação só enquanto ninguém digitou neles.
  const editingSender = editor && editor !== 'new' ? snapshot?.senders.find(sender => sender.id === editor.id) ?? editor : null
  const companyForm = useFormKey(JSON.stringify(snapshot?.company ?? null))
  const senderForm = useFormKey(JSON.stringify(editingSender))
  const [guide, setGuide] = React.useState<EmailSender | null>(null)
  const [companyOpen, setCompanyOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  async function run(fn: () => Promise<unknown>, success: string) { setBusy(true); setError(''); try { await fn(); toast.success(success); data.reload(); return true } catch (e) { setError(messageOf(e)); toast.error(messageOf(e)); return false } finally { setBusy(false) } }
  if (data.error && !snapshot) return <Banner variant="danger"><p>Não foi possível carregar o e-mail.</p><Button variant="secondary" onClick={data.reload}>Tentar novamente</Button></Banner>
  if (!snapshot) return <div role="status" aria-label="Carregando e-mail" className="space-y-4"><Skeleton className="h-24"/><Skeleton className="h-64"/></div>
  const company = snapshot.company
  return <section aria-label="Configurações de e-mail" className="min-w-0 space-y-6">
    {snapshot.usage.paused && <Banner variant="warning"><p>{emailPauseNotice(snapshot.usage.pauseReason)}</p><Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => updateEmailSettings({ paused: false }), "Envios retomados.")}>Retomar envios</Button></Banner>}
    {error && !editor && <Banner variant="danger">{error}</Banner>}
    <SettingsRows label="Canal de e-mail">
      <SettingsRow label="Canal de e-mail" help="Use Marketing por e-mail para se manter em contato com quem já demonstrou interesse na sua marca. Defina quem assina as mensagens e os dados legais do rodapé.">
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-sm font-medium"><span aria-hidden className={snapshot.usage.paused ? "size-2 rounded-full bg-warning" : "size-2 rounded-full bg-success"} />{snapshot.usage.paused ? "Pausado" : "Habilitado"}</p>
          <div><h3 className="text-sm font-semibold">Informação do contato</h3>
            <dl className="mt-2 space-y-2 text-sm"><div><dt className="text-xs text-text-muted">Empresa / Organização</dt><dd>{company.name || "Não informada"}</dd></div><div><dt className="text-xs text-text-muted">Endereço</dt><dd>{company.address || "Não informado"}</dd></div></dl></div>
          <Button type="button" variant="secondary" onClick={() => setCompanyOpen(true)}>Editar informações do contato</Button>
        </div>
      </SettingsRow>
    </SettingsRows>
    <section aria-label="Enviar de" className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-lg font-semibold">Enviar de</h3><div className="flex flex-wrap gap-2"><Button variant="secondary" asChild><Link to={`/${workspace}/settings/email/design`}>Criar e-mail</Link></Button><Button onClick={()=>setEditor('new')}><Plus className="size-4"/>Novo endereço</Button></div></header>
      <div className="divide-y divide-border rounded-lg border border-border bg-surface">
        {snapshot.senders.length === 0 && <p className="p-6 text-text-muted">Nenhum remetente cadastrado. Adicione um endereço para começar.</p>}
        {snapshot.senders.map(sender=>{ const isDefault = sender.isDefault || sender.id === snapshot.defaultSenderId; return <div key={sender.id} className="grid gap-x-6 gap-y-3 px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,0.8fr)_auto] lg:items-center">
          <div className="min-w-0"><p className="text-xs text-text-muted">E-mail</p><p className="flex items-center gap-1 break-all font-medium">{isDefault && <Star aria-label="Padrão" className="size-3.5 shrink-0 text-accent"/>}{sender.address}</p></div>
          <div className="min-w-0"><p className="text-xs text-text-muted">Nome do remetente</p><h4 className="break-words font-medium">{sender.name || 'Remetente da plataforma'}</h4></div>
          <div className="min-w-0"><p className="text-xs text-text-muted">Responder para</p><p className="break-all font-medium">{sender.replyTo || sender.address}</p></div>
          <p className="inline-flex items-center gap-1 text-sm text-text-muted"><ShieldCheck className="size-3.5 shrink-0"/>{statusLabels[sender.status] ?? sender.status}</p>
          <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="secondary" disabled={busy} onClick={()=>setEditor(sender)}>Editar</Button>{!isDefault && <><Button size="sm" variant="ghost" disabled={busy || sender.status !== 'verified'} aria-describedby={sender.status !== 'verified' ? `sender-hint-${sender.id}` : undefined} onClick={()=>void run(()=>updateEmailSettings({defaultSenderId:sender.id}),'Remetente padrão atualizado.')}>Usar como padrão</Button>{sender.status !== 'verified' && <span id={`sender-hint-${sender.id}`} className="basis-full text-xs text-text-muted">Só um endereço confirmado pode ser o padrão. Confirme o endereço primeiro.</span>}</>}{(!['verified','connected'].includes(sender.status) || sender.dns?.length > 0) && <Button size="sm" variant="ghost" onClick={()=>setGuide(sender)}>Configurar domínio</Button>}</div>
        </div>})}
      </div>
    </section>
    <SettingsRows label="Provedor e uso">
      <SettingsRow label="Provedor de marketing" help="O serviço padrão só envia e-mails transacionais. Para transmissões de marketing e verificação de domínio, cole a chave da API do Resend."><MarketingProvider /></SettingsRow>
      <SettingsRow label="Uso neste ciclo" help="Mensagens de e-mail enviadas no ciclo atual."><p className="text-lg font-semibold" aria-label="Enviados neste ciclo">{new Intl.NumberFormat('pt-BR',{maximumFractionDigits:3}).format(snapshot.usage.sent)} <span className="text-sm font-normal text-text-muted">enviados</span></p></SettingsRow>
    </SettingsRows>
    <EmailStopSettings/>
    <EmailMetricsPanel/>
    <Banner>Ambiente de estudo: testes e marketing usam transporte simulado. Marketing em produção está bloqueado.</Banner>
    {companyOpen && <Dialog open onOpenChange={open=>{ if(!open){ setCompanyOpen(false); companyForm.release() } }}><DialogContent><DialogHeader><DialogTitle>Informações do contato</DialogTitle><DialogDescription>Nome e endereço aparecem no rodapé legal. Preencha ambos antes de enviar.</DialogDescription></DialogHeader><CompanyForm key={companyForm.key} onChange={companyForm.touch} snapshot={snapshot} busy={busy} onSave={async value=>{ if(await run(()=>updateEmailSettings({company:value}),'Dados da empresa salvos.')) { setCompanyOpen(false); companyForm.release() } }}/>{error && <Banner variant="danger">{error}</Banner>}</DialogContent></Dialog>}
    {editor && <Dialog open onOpenChange={open=>{ if(!open){ setEditor(null); senderForm.release() } }}><DialogContent><DialogHeader><DialogTitle>{editor === 'new' ? 'Novo endereço de envio' : 'Editar remetente'}</DialogTitle><DialogDescription>Para domínio próprio, use um endereço da sua empresa. Serviços gratuitos não são aceitos.</DialogDescription></DialogHeader><SenderForm key={senderForm.key} onChange={senderForm.touch} sender={editingSender} busy={busy} onSave={async input=>{ if(await run(()=>saveEmailSender(input,editor === 'new' ? undefined : editor.id),'Remetente salvo.')){ setEditor(null); senderForm.release() } }}/>{error && <Banner variant="danger">{error}</Banner>}</DialogContent></Dialog>}
    {guide && <DomainGuide sender={guide} busy={busy} onClose={()=>setGuide(null)} onVerify={(stage,ack)=>run(async()=>{const next=await verifyEmailSender(guide.id,{stage,warmupAccepted:ack});setGuide(next)},'Verificação local concluída. Nenhum DNS real foi alterado.')}/>}
  </section>
}
function CompanyForm({ snapshot, busy, onSave, onChange }: { snapshot: EmailSettings; busy: boolean; onSave: (value: EmailSettings['company'])=>Promise<unknown>; onChange?: ()=>void }) {
 return <form className="space-y-4" onChange={onChange} onSubmit={event=>{event.preventDefault();const fields=new FormData(event.currentTarget);void onSave({name:String(fields.get('company')),address:String(fields.get('address'))})}}><div className="space-y-2"><Label htmlFor="email-company">Nome da empresa</Label><Input id="email-company" name="company" required maxLength={160} defaultValue={snapshot.company.name}/></div><div className="space-y-2"><Label htmlFor="email-company-address">Endereço da empresa</Label><Input id="email-company-address" name="address" required maxLength={500} defaultValue={snapshot.company.address}/></div><div className="flex justify-end"><Button type="submit" loading={busy}>Salvar dados da empresa</Button></div></form>
}
function SenderForm({sender,busy,onSave,onChange}:{sender:EmailSender|null;busy:boolean;onSave:(value:{address:string;name:string;replyTo:string;branding:boolean})=>Promise<void>;onChange?:()=>void}) {
 const [branding,setBranding]=React.useState(sender?.branding ?? true)
 return <form className="space-y-4" onChange={onChange} onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void onSave({address:String(f.get('address') ?? sender?.address ?? ''),name:String(f.get('name')),replyTo:String(f.get('replyTo')),branding})}}>{!sender && <div className="space-y-2"><Label htmlFor="sender-address">Endereço de e-mail</Label><Input id="sender-address" name="address" type="email" required placeholder="equipe@suaempresa.com.br"/></div>}<div className="space-y-2"><Label htmlFor="sender-name">Nome do remetente</Label><Input id="sender-name" name="name" required maxLength={120} defaultValue={sender?.name}/></div><div className="space-y-2"><Label htmlFor="sender-reply">Responder para</Label><Input id="sender-reply" name="replyTo" type="email" defaultValue={sender?.replyTo}/></div><div className="flex items-center justify-between gap-3"><Label htmlFor="sender-branding">Mostrar assinatura da plataforma no rodapé</Label><Switch id="sender-branding" checked={branding} onCheckedChange={on=>{ setBranding(on); onChange?.() }}/></div><div className="flex justify-end"><Button type="submit" loading={busy}>Salvar remetente</Button></div></form>
}
function DomainGuide({sender,busy,onClose,onVerify}:{sender:EmailSender;busy:boolean;onClose:()=>void;onVerify:(stage:'address'|'dns'|'resend',ack?:boolean)=>Promise<boolean>}) {
 const [ack,setAck]=React.useState(false)
 return <Dialog open onOpenChange={open=>!open && onClose()}><DialogContent className="max-h-[90vh] overflow-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Autenticar {sender.domain}</DialogTitle><DialogDescription>Configure os registros no seu provedor de DNS. A plataforma não altera sua conta.</DialogDescription></DialogHeader><ol className="space-y-5 text-sm"><li><h3 className="font-semibold">1. Confirme o endereço</h3><p className="mt-1 text-text-muted">Verifique a caixa de entrada e o spam de {sender.address}. A confirmação deste ambiente é simulada.</p><Button className="mt-2" size="sm" variant="secondary" loading={busy} onClick={()=>void onVerify('resend')}>Reenviar verificação</Button>{sender.status === 'unverified' && <Button className="ml-2 mt-2" size="sm" loading={busy} onClick={()=>void onVerify('address')}>Confirmar endereço (simulado)</Button>}</li><li><h3 className="font-semibold">2. Adicione os registros DNS</h3><p className="my-2 text-text-muted">Conclua em até 3 dias. Se o provedor acrescenta o domínio sozinho, use apenas o prefixo no campo Nome.</p><div className="space-y-2">{sender.dns.map((record,index)=><div key={index} className="rounded border border-border bg-bg p-3"><div className="flex items-start justify-between gap-2"><p className="font-mono text-xs">{record.type}</p><Button size="sm" variant="ghost" aria-label={`Copiar registro ${index+1}`} onClick={()=>void navigator.clipboard.writeText(`${record.name}\n${record.value}`).then(()=>toast.success('Registro copiado.'))}><Copy className="size-4"/></Button></div><p className="break-all font-mono text-xs">{record.name}</p><p className="mt-1 break-all font-mono text-xs text-text-muted">{record.value}</p></div>)}</div>{sender.verificationExpiresAt && <p className="mt-2 text-xs text-text-muted">Prazo: {new Date(sender.verificationExpiresAt).toLocaleString('pt-BR')}</p>}</li><li><h3 className="font-semibold">3. Verifique e prepare o domínio</h3><p className="mt-1 text-text-muted">Aumente o volume aos poucos nas primeiras 2 a 4 semanas para cuidar da reputação de envio.</p><label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={ack} onChange={event=>setAck(event.target.checked)}/><span>Entendi que preciso aquecer a reputação do domínio.</span></label><Button className="mt-3" loading={busy} disabled={!ack || sender.status !== 'dns_pending'} onClick={()=>void onVerify('dns',ack)}><CheckCircle2 className="size-4"/>Verificar registros (simulado)</Button></li></ol></DialogContent></Dialog>
}

/** Só se há chave configurada: a chave do Resend nunca volta do motor (a digitada fica no estado do campo). */
export const loadMarketingProvider = () => isFakeMode() ? Promise.resolve({ configured: false }) : apiRequest<{ configured: boolean }>("/email/marketing-provider")
/** Provedor de marketing (Resend): com a chave, transmissões de marketing e verificação de domínio funcionam de verdade em produção. */
function MarketingProvider() {
  const { workspace = '' } = useParams()
  const state = useAsync(loadMarketingProvider, "marketing-provider", { cache: settingsKeys.marketingProvider(workspace) })
  const [key, setKey] = React.useState("")
  const act = (p: Promise<unknown>, ok: string) => p.then(() => { toast.success(ok); setKey(""); state.reload() }).catch((e: Error) => toast.error(e.message))
  return <div className="space-y-2">
    {state.data?.configured ? <p className="text-sm">Chave configurada.</p> : null}
    <div className="flex flex-wrap gap-2"><input aria-label="Chave do Resend" type="password" placeholder="re_..." value={key} onChange={e => setKey(e.target.value)} className="min-w-0 flex-1 rounded-md border border-border-input bg-surface px-3 py-2 text-sm" />
      <Button disabled={!key.trim()} onClick={() => void act(apiRequest("/email/marketing-provider", { method: "PUT", body: JSON.stringify({ api_key: key.trim() }) }), "Provedor de marketing salvo.")}>Salvar</Button>
      {state.data?.configured ? <Button variant="ghost" onClick={() => void act(apiRequest("/email/marketing-provider", { method: "DELETE" }), "Chave removida.")}>Remover</Button> : null}</div>
  </div>
}
