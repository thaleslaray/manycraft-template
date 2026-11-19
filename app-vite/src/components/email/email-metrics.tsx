import { RefreshCw } from 'lucide-react'
import { useParams } from 'react-router'
import { getEmailMetrics } from '@/data/email'
import { useAsync } from '@/hooks/use-async'
import { settingsKeys } from "@/data/screen-keys"
import { Banner } from '@/components/ui/banner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
export function EmailMetricsPanel(){
 const {workspace=''}=useParams()
 const data=useAsync(getEmailMetrics,'email-metrics',{cache:settingsKeys.emailMetrics(workspace)})
 const snapshot=data.data ?? data.stale
 return <section className="space-y-4 rounded-lg border border-border bg-surface p-4 sm:p-6" aria-label="Resultados de e-mail"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">Resultados de e-mail</h3><p className="mt-1 text-xs text-text-muted">Contatos únicos com eventos registrados neste espaço de trabalho.</p></div><Button size="sm" variant="ghost" onClick={data.reload}><RefreshCw className="size-4"/>Atualizar resultados</Button></div>{data.error?<Banner variant="danger">Não foi possível carregar os resultados. Tente atualizar.</Banner>:!snapshot?<Skeleton className="h-24"/>:<><dl className="grid grid-cols-2 gap-5 lg:grid-cols-5">{[['Enviado',snapshot.sent],['Entregue',snapshot.delivered],['Aberto',snapshot.opened],['Clicado',snapshot.clicked]].map(([name,value])=><div key={name}><dt className="text-xs text-text-muted">{name}</dt><dd className="mt-1 text-lg font-semibold">{new Intl.NumberFormat('pt-BR').format(Number(value))}</dd></div>)}<div><dt className="text-xs text-text-muted">CTR</dt><dd className="mt-1 text-lg font-semibold">{new Intl.NumberFormat('pt-BR',{style:'percent',maximumFractionDigits:1}).format(snapshot.ctr)}</dd></div></dl><div className="space-y-2 border-t border-border pt-4 text-xs text-text-muted"><p><strong>Entregue:</strong> {snapshot.definitions.delivered}</p><p><strong>Aberto:</strong> {snapshot.definitions.opened}</p><p><strong>CTR:</strong> proporção entre contatos que clicaram e contatos com envio registrado. Estes resultados reúnem os eventos de e-mail do espaço.</p></div></>}</section>
}
