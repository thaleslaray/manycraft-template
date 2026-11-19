import { useState, type FormEvent } from 'react'
import { useParams } from 'react-router'
import { toast } from 'sonner'
import { apiRequest } from '@/data/api'
import { listConnections } from '@/data/connections'
import { listAutomations } from '@/data'
import { useAsync } from '@/hooks/use-async'
import { useFormKey } from '@/hooks/use-draft'
import { settingsKeys } from '@/data/screen-keys'
import { Banner } from '@/components/ui/banner'
import { Button } from '@/components/ui/button'
import { Input, Textarea, field } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

type StopSettings={enabled:boolean;subject:string;text:string;automationId:string|null}
export function EmailStopSettings(){
 const {workspace=''}=useParams()
 const data=useAsync(async()=>({connections:(await listConnections(workspace)).filter(connection=>connection.profile?.email),automations:await listAutomations(workspace)}),`email-stop-options:${workspace}`,{cache:settingsKeys.emailStopOptions(workspace)})
 const [connectionId,setConnectionId]=useState('')
 const selected=connectionId || data.data?.connections[0]?.id
 return <section aria-label="Automação de descadastro de e-mail" className="space-y-4 rounded-lg border border-border bg-surface p-4 sm:p-6"><div><h3 className="font-semibold">Após o descadastro</h3><p className="mt-1 text-sm text-text-muted">Uma resposta com STOP, UNSUBSCRIBE, parar ou sair cancela o marketing por e-mail. Configure a confirmação e a automação de saída.</p></div>{data.error?<Banner variant="danger">Não foi possível carregar as conexões.<Button variant="link" onClick={data.reload}>Tentar novamente</Button></Banner>:!data.data?<Skeleton className="h-20"/>:!data.data.connections.length?<p className="text-sm text-text-muted">Conecte um endereço de e-mail para configurar a saída.</p>:<><div className="space-y-2"><Label htmlFor="email-stop-connection">Conexão da saída</Label><select id="email-stop-connection" className={`${field} h-10`} value={selected} onChange={e=>setConnectionId(e.target.value)}>{data.data.connections.map(connection=><option key={connection.id} value={connection.id}>{connection.displayName || connection.label}</option>)}</select></div>{selected&&<StopForm key={selected} workspace={workspace} connectionId={selected} automations={data.data.automations}/>}</>}</section>
}
function StopForm({workspace,connectionId,automations}:{workspace:string;connectionId:string;automations:{id:string;name:string;status:string}[]}){
 const data=useAsync(()=>apiRequest<StopSettings>(`/email/connections/${encodeURIComponent(connectionId)}/stop`),`email-stop:${connectionId}`,{cache:settingsKeys.emailStop(workspace,connectionId)})
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 // Nasce do cache e remonta com a revalidação só enquanto ninguém mexeu.
 const form=useFormKey(JSON.stringify(data.data ?? null))
 async function save(event:FormEvent<HTMLFormElement>){event.preventDefault();const values=new FormData(event.currentTarget);setBusy(true);setError('');try{await apiRequest(`/email/connections/${encodeURIComponent(connectionId)}/stop`,{method:'PUT',body:JSON.stringify({enabled:values.get('enabled')==='on',subject:String(values.get('subject')),text:String(values.get('text')),automationId:values.get('automationId')||null})});data.reload();form.release();toast.success('Saída de e-mail salva.')}catch(error){setError(error instanceof Error?error.message:'Não foi possível salvar a saída.')}finally{setBusy(false)}}
 if(data.error)return <Banner variant="danger">Não foi possível carregar a saída.<Button variant="link" onClick={data.reload}>Tentar novamente</Button></Banner>
 if(!data.data)return <Skeleton className="h-32"/>
 return <form key={form.key} onChange={form.touch} onSubmit={save} className="space-y-4"><label className="flex items-center gap-2 text-sm"><input name="enabled" type="checkbox" defaultChecked={data.data.enabled}/>Executar confirmação e automação após descadastro</label><div className="space-y-2"><Label htmlFor="email-stop-subject">Assunto da confirmação</Label><Input id="email-stop-subject" name="subject" maxLength={998} defaultValue={data.data.subject}/></div><div className="space-y-2"><Label htmlFor="email-stop-text">Mensagem de confirmação</Label><Textarea id="email-stop-text" name="text" maxLength={10000} rows={3} defaultValue={data.data.text}/></div><div className="space-y-2"><Label htmlFor="email-stop-flow">Automação após STOP</Label><select id="email-stop-flow" name="automationId" className={`${field} h-10`} defaultValue={data.data.automationId ?? ''}><option value="">Sem automação adicional</option>{automations.filter(row=>row.status==='live').map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></div><p className="text-xs text-text-muted">A confirmação de saída é transacional. A automação adicional continua respeitando o descadastro: mensagens de marketing permanecem bloqueadas.</p>{error&&<Banner variant="danger">{error}</Banner>}<Button type="submit" loading={busy}>Salvar saída de e-mail</Button></form>
}
