import { useState } from "react"
import { listAudienceContacts, type BroadcastAudience, type BroadcastTemplate, type BroadcastWindowKind } from "@/data/broadcasts"
import { useAsync } from "@/hooks/use-async"
import { Button } from "@/components/ui/button"
import { AvatarInitials } from "@/components/ui/avatar-initials"

/** Lista paginada (nome e foto) de quem receberia a transmissão; só pede ao motor quando o pop-up está aberto. */
export function AudiencePreviewList({ workspace, audience, template, windowKind }: { workspace: string; audience: BroadcastAudience; template?: BroadcastTemplate; windowKind: BroadcastWindowKind }) {
  const [page, setPage] = useState(1)
  const result = useAsync(() => listAudienceContacts(audience, template, windowKind, page), `audience-list|${workspace}|${audience.channel_id}|${audience.tag}|${audience.email_filter ?? ""}|${audience.segment_id ?? ""}|${template?.id ?? ""}|${windowKind}|${page}`)
  if (result.error) return <p role="alert" className="text-sm text-danger">Não foi possível carregar a lista. <Button type="button" variant="link" onClick={result.reload}>Tentar de novo</Button></p>
  if (!result.data) return <p role="status" className="text-sm text-text-muted">Carregando a lista.</p>
  const { contacts, total, limit } = result.data, last = Math.max(1, Math.ceil(total / limit))
  if (!contacts.length) return <p className="text-sm text-text-muted">Nenhum contato receberia esta transmissão.</p>
  return <div className="space-y-2">
    <ul aria-label="Contatos que recebem" className="max-h-72 divide-y divide-border overflow-y-auto rounded border border-border">
      {contacts.map(contact => <li key={contact.id} className="flex items-center gap-3 px-3 py-2 text-sm"><AvatarInitials name={contact.name} src={contact.photo ?? undefined} className="size-8" /><span className="min-w-0 truncate">{contact.name}</span></li>)}
    </ul>
    <div className="flex items-center justify-between text-sm text-text-muted">
      <span>Página {page} de {last}</span>
      <span className="flex gap-2"><Button type="button" variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</Button><Button type="button" variant="secondary" size="sm" disabled={page >= last} onClick={() => setPage(page + 1)}>Próxima</Button></span>
    </div>
  </div>
}
