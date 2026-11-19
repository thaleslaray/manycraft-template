import { Link, useParams } from 'react-router'
import { ArrowLeft, ListFilter, Users } from 'lucide-react'
import { useAsync } from '@/hooks/use-async'
import { getSegment, listSegments } from '@/data/segments'
import { Button } from '@/components/ui/button'
import { ContactsView } from './contacts-view'

export function SegmentContactsPage() {
  const { segmentId } = useParams() as { segmentId: string }
  const segment = useAsync(() => getSegment(segmentId), segmentId)
  if (segment.error) return <div role="alert" className="space-y-3"><h1 className="text-xl font-bold">Não foi possível abrir o segmento</h1><p>Ele pode ter sido removido ou conter uma opção indisponível.</p><Button onClick={segment.reload}>Tentar novamente</Button></div>
  if (!segment.data) return <p role="status">Carregando segmento…</p>
  return <ContactsView key={segmentId} segment={segment.data} />
}
export function SegmentsPage() {
  const { workspace } = useParams()
  const list = useAsync(listSegments, `${workspace}|segments`, { cache: `segments-page|${workspace}` })
  return <div className="space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="flex items-center gap-2 text-xl font-bold"><ListFilter className="size-5" aria-hidden="true" />Segmentos</h1><Button variant="secondary" asChild><Link to={`/${workspace}/contacts`}><ArrowLeft className="size-4" aria-hidden="true" />Voltar aos contatos</Link></Button></header>
    <p className="max-w-2xl text-sm text-text-muted">Guarde critérios de seleção para reutilizar em transmissões e condições. A lista de pessoas acompanha as mudanças nos contatos.</p>
    {list.error ? <div role="alert" className="space-y-3"><p>Não foi possível listar os segmentos.</p><Button onClick={list.reload}>Tentar novamente</Button></div> : list.loading ? <p role="status">Carregando segmentos…</p> : !list.data?.length ? <div className="rounded-lg border border-border bg-surface p-8"><h2 className="font-semibold">Nenhum segmento salvo</h2><p className="mt-2 text-sm text-text-muted">Abra Contatos, adicione condições ao filtro e escolha Salvar como segmento.</p></div> : <ul className="divide-y divide-border rounded-lg border border-border bg-surface">{list.data.map(segment => <li key={segment.id} className="flex flex-wrap items-center justify-between gap-3 p-5"><div className="min-w-0"><h2 className="break-words font-semibold">{segment.name}</h2><p className="mt-1 flex items-center gap-2 text-sm text-text-muted"><Users className="size-4" aria-hidden="true" />{segment.total === null ? 'Critérios indisponíveis' : `${segment.total} ${segment.total === 1 ? 'contato' : 'contatos'}`} · {segment.filter.match === 'all' ? 'Todas as condições' : 'Qualquer condição'}</p></div><Button variant="secondary" asChild><Link aria-label={`Abrir ${segment.name}`} to={`/${workspace}/contacts/segments/${segment.id}`}>Abrir segmento</Link></Button></li>)}</ul>}
  </div>
}
