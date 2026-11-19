import { Bookmark, AtSign } from 'lucide-react'
import { listSavedReplies } from '@/data/inbox-team'
import type { InboxMember } from '@/data/inbox'
import { useAsync } from '@/hooks/use-async'
import { Button } from '@/components/ui/button'

export function InboxComposerTools({ mode, body, members, disabled, onBody, onMention }: {
  mode: 'reply' | 'note'; body: string; members: InboxMember[]; disabled: boolean;
  onBody: (body: string) => void; onMention: (member: InboxMember) => void
}) {
  const replies = useAsync(listSavedReplies, 'saved-replies')
  const mention = mode === 'note' ? body.match(/(?:^|\s)@([^\s@]*)$/u) : null
  if (mention) return <div aria-label="Pessoas para mencionar" className="space-y-1 rounded-md border border-border bg-surface p-2">
    <p className="flex items-center gap-1 text-xs text-text-muted"><AtSign className="size-3" />Mencionar na nota</p>
    {members.filter(m => m.name.toLocaleLowerCase().includes(mention[1].toLocaleLowerCase())).map(member => <Button key={member.id} type="button" variant="ghost" size="sm" disabled={disabled} aria-label={`Mencionar ${member.name}`} onClick={() => { onMention(member); onBody(body.replace(/@([^\s@]*)$/u, `@${member.name} `)) }}>{member.name}</Button>)}
  </div>
  if (mode !== 'reply' || !body.startsWith('/')) return null
  const rows = (replies.data ?? []).filter(r => `${r.shortcut} ${r.body}`.toLocaleLowerCase().includes(body.slice(1).toLocaleLowerCase()))
  return <div aria-label="Respostas salvas" className="space-y-2 rounded-md border border-border bg-surface p-2"><p className="flex items-center gap-1 text-xs text-text-muted"><Bookmark className="size-3" />Respostas salvas</p>
    {replies.error ? <p role="alert" className="text-xs text-danger">Não foi possível buscar respostas. <button type="button" onClick={replies.reload}>Tentar de novo</button></p> : replies.loading && !replies.data ? <p role="status">Buscando respostas…</p> : rows.length ? rows.map(reply => <Button key={reply.id} type="button" variant="ghost" size="sm" className="h-auto w-full justify-start whitespace-normal text-left" disabled={disabled} aria-label={`Usar /${reply.shortcut}`} onClick={() => onBody(reply.body)}><span className="min-w-0"><strong>/{reply.shortcut}</strong><span className="block truncate text-xs text-text-muted">{reply.body}</span></span></Button>) : <p className="text-xs text-text-muted">Nenhuma resposta encontrada. Crie atalhos em Configurações → Caixa de entrada.</p>}
  </div>
}
