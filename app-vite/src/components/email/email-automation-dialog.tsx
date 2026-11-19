import * as React from 'react'
import { Link, useParams } from 'react-router'
import { getAutomation, listAutomations } from '@/data'
import { listConnections } from '@/data/connections'
import { attachEmailDraftToAutomation } from '@/data/email'
import { useAsync } from '@/hooks/use-async'
import { Banner } from '@/components/ui/banner'
import { Button } from '@/components/ui/button'
import { field } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function EmailAutomationDialog({draftId,onClose}:{draftId:string;onClose:()=>void}) {
 const {workspace=''}=useParams()
 const data=useAsync(async()=>{const [rows,connections]=await Promise.all([listAutomations(workspace),listConnections(workspace)]);const eligible=new Set(connections.filter(connection=>connection.status === 'connected' && connection.profile?.email).map(connection=>connection.id));const details=await Promise.all(rows.map(row=>getAutomation(workspace,row.id)));return details.filter(detail=>detail?.triggers.some(trigger=>trigger.channel_id !== null && eligible.has(trigger.channel_id))).filter(detail=>detail !== null)},`email-automations:${workspace}`)
 const [automationId,setAutomationId]=React.useState(''),[nodeId,setNodeId]=React.useState(''),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[attached,setAttached]=React.useState(false)
 const selection=data.data?.find(detail=>detail.automation.id === automationId)
 const nodes=selection?.automation.draft_graph.nodes.filter(node=>node.type === 'message') ?? []
 return <Dialog open onOpenChange={open=>!open && onClose()}><DialogContent><DialogHeader><DialogTitle>Usar em uma automação</DialogTitle><DialogDescription>O design é copiado para uma mensagem em rascunho. Publique a automação no editor para ativar a alteração.</DialogDescription></DialogHeader>{data.error?<Banner variant="danger">Não foi possível carregar as automações.<Button variant="secondary" onClick={data.reload}>Tentar novamente</Button></Banner>:!data.data?<p role="status">Carregando automações…</p>:!data.data.length?<Banner>Nenhuma automação tem uma conexão compatível com e-mail. Configure uma conexão e um gatilho primeiro.</Banner>:<form className="space-y-4" onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');try{await attachEmailDraftToAutomation(draftId,automationId,nodeId);setAttached(true)}catch(error){setError(error instanceof Error?error.message:'Não foi possível aplicar o design.')}finally{setBusy(false)}}}><div className="space-y-2"><Label htmlFor="email-automation">Automação</Label><select className={`${field} h-10 w-full`} id="email-automation" value={automationId} required onChange={event=>{setAutomationId(event.target.value);setNodeId('');setAttached(false)}}><option value="">Selecione uma automação</option>{data.data.map(detail=><option key={detail.automation.id} value={detail.automation.id}>{detail.automation.name}</option>)}</select></div><div className="space-y-2"><Label htmlFor="email-message-node">Mensagem da automação</Label><select className={`${field} h-10 w-full`} id="email-message-node" value={nodeId} required onChange={event=>{setNodeId(event.target.value);setAttached(false)}}><option value="">Selecione um passo de mensagem</option>{nodes.map((node,index)=><option key={node.id} value={node.id}>Mensagem {index+1} · {node.id}</option>)}</select></div>{error&&<Banner variant="danger">{error}</Banner>}{attached?<Banner>Design aplicado ao rascunho.<Link className="ml-2 underline" to={`/${workspace}/automations/${automationId}`}>Abrir editor para publicar</Link></Banner>:<Button type="submit" disabled={!automationId || !nodeId} loading={busy}>Aplicar design ao passo</Button>}</form>}</DialogContent></Dialog>
}
