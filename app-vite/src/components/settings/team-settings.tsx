import { cn } from '@/lib/utils'
import { useState } from 'react'
import { useParams } from 'react-router'
import { Copy, LogOut, UserPlus } from 'lucide-react'
import { useWorkspaceSettings } from '@/hooks/use-workspace-settings'
import { InboxGroups } from './inbox-assignment'
import { toast } from 'sonner'
import { useAsync } from '@/hooks/use-async'
import { settingsKeys } from "@/data/screen-keys"
import { isFakeMode } from '@/data/api'
import { resetWorkspaceContext } from '@/data/auth'
import { approveAccessRequest, cancelTeamInvite, denyAccessRequest, listAccessRequests, getTeam, inviteTeamMember, reissueInviteLink, removeTeamMember, signOutEverywhere, teamRoleLabels, transferTeamOwnership, updateTeamMember, type IssuedInvite, type TeamInvite, type TeamMember } from '@/data/team'
import { AvatarInitials } from '@/components/ui/avatar-initials'
import { Banner } from '@/components/ui/banner'
import { Button } from '@/components/ui/button'
import { Input, field } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsCard, SettingsRow, SettingsRows, SettingsTabs } from './settings-rows'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const assignableRoles = Object.entries(teamRoleLabels).filter(([role]) => role !== 'owner') as [TeamInvite['role'], string][]

const roleOrder = ['owner', 'administrator', 'editor', 'livechat_agent', 'viewer'] as const
const roleHelp: Record<(typeof roleOrder)[number], string> = {
  owner: 'Controla toda a conta: equipe, conexões, conteúdo e exclusão do espaço. Há apenas um proprietário por conta.',
  administrator: 'Gerencia a equipe, as conexões e todo o conteúdo, exceto transferir ou excluir o espaço.',
  editor: 'Cria e edita automações, contatos, transmissões e o conteúdo do espaço, mas não mexe na equipe nem nas conexões.',
  livechat_agent: 'Atende as conversas da caixa de entrada. Não vê as automações nem altera configurações.',
  viewer: 'Só consulta o espaço. Não altera nada e não responde conversas.',
}

export function TeamSettingsPanel({ tab = 'members' }: { tab?: 'members' | 'groups' }) {
  const { workspace = 'demo' } = useParams()
  const accountName = useWorkspaceSettings()?.name ?? ''
  const [editing, setEditing] = useState<string | null>(null)
  const data = useAsync(getTeam, 'team', { cache: settingsKeys.team(workspace) })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [issued, setIssued] = useState<IssuedInvite | null>(null)
  const [transfer, setTransfer] = useState<TeamMember | null>(null)
  const [removal, setRemoval] = useState<TeamMember | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [logoutOpen, setLogoutOpen] = useState(false)
  const snapshot = data.data ?? data.stale
  const current = snapshot?.members.find(member => member.is_current)
  const owner = current?.role === 'owner'
  const canManage = owner || current?.role === 'administrator'

  async function run(task: () => Promise<unknown>, message: string) {
    setBusy(true); setError('')
    try { await task(); toast.success(message); data.reload(); return true }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a alteração.'); return false }
    finally { setBusy(false) }
  }

  /** O motor guarda só o hash do token: copiar o link de um convite pendente emite um link novo; sem permissão de área de transferência, o pop-up mostra o link. */
  async function copyInviteLink(invite: TeamInvite) {
    setBusy(true); setError('')
    try {
      const fresh = await reissueInviteLink(invite.id)
      try { await navigator.clipboard.writeText(fresh.url); toast.success('Link copiado. O link anterior deste convite deixou de valer.') }
      catch { setIssued(fresh); setInviteOpen(true) }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível gerar o link do convite.') }
    finally { setBusy(false) }
  }

  const tabs = [{ to: `/${workspace}/settings/team`, label: 'Membros da equipe' }, { to: `/${workspace}/settings/team/groups`, label: 'Grupos' }]
  if (tab === 'groups') return <section aria-label="Grupos da equipe" className="space-y-5"><SettingsTabs label="Equipe" tabs={tabs} /><InboxGroups /></section>
  return <section aria-label="Equipe" className="space-y-5 lg:-mt-4">
    <SettingsTabs label="Equipe" tabs={tabs} />
    {isFakeMode() && <Banner>Demonstração: os convites e as alterações de equipe são simulados.</Banner>}
    {error && <Banner variant="danger"><span role="alert">{error}</span></Banner>}
    {data.error ? <Banner variant="danger">Seu papel pode não permitir gerenciar a equipe. <Button variant="secondary" size="sm" onClick={data.reload}>Tentar de novo</Button></Banner>
      : !snapshot ? <Skeleton className="h-56" /> : <>
        <SettingsCard title={<>Membros da equipe{accountName ? ` de ${accountName}` : ''}</>}
          action={canManage ? <Button onClick={() => { setIssued(null); setInviteOpen(true); setError('') }}><UserPlus className="size-4" aria-hidden="true" />Convidar membro</Button> : undefined}>
          <div role="table" aria-label="Membros da equipe" aria-busy={busy} className="border-t border-border">
            {roleOrder.map(role => {
              const members = snapshot.members.filter(member => member.role === role)
              if (!members.length) return null
              return <div role="rowgroup" key={role} aria-label={teamRoleLabels[role]}>
                <div role="row"><div role="rowheader" aria-colspan={3} className="px-4 pb-2 pt-8 sm:px-6"><h3 className="text-sm">{teamRoleLabels[role]}</h3><p className="text-sm text-text-muted">{roleHelp[role]}</p></div></div>
                <div role="row" className={cn("hidden grid-cols-[minmax(0,1fr)_19.5rem_4rem] gap-4 px-4 pb-1 pt-4 text-xs font-semibold sm:px-6", role === "owner" ? "sm:grid" : "sr-only")}><span role="columnheader">Nome</span><span role="columnheader">Caixa de entrada</span><span role="columnheader"><span className="sr-only">Ações</span></span></div>
                {members.map((member, index) => {
                  const editable = canManage && member.role !== 'owner' && (owner || member.role !== 'administrator')
                  const open = editing === member.id
                  return <div role="row" key={member.id} className={cn("border-border px-4 py-4.5 sm:px-6", index > 0 && "border-t")}>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_19.5rem_4rem]">
                      <div role="cell" className="flex min-w-0 items-center gap-3">
                        <AvatarInitials name={member.name} src={member.image ?? undefined} className="size-7 text-2xs" />
                        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3"><p className="flex items-center gap-2 text-sm">{member.name}{member.is_current && <span className="text-xs text-text-muted">Você</span>}</p><p className="min-w-0 truncate text-xs text-text-muted" title={member.email}>{member.email}</p></div>
                      </div>
                      <div role="cell" className="text-sm text-text-muted">{member.role === 'owner' || member.inbox_seat ? <><span aria-hidden="true">✓</span><span className="sr-only">Com assento</span></> : <><span aria-hidden="true">—</span><span className="sr-only">Sem assento</span></>}</div>
                      <div role="cell" className="text-right">{editable ? <Button variant="link" size="sm" aria-expanded={open} aria-label={`Editar ${member.name}`} onClick={() => setEditing(open ? null : member.id)}>Editar</Button> : null}</div>
                    </div>
                    {open && editable ? <div className="mt-3 grid gap-4 rounded-md bg-surface-muted p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
                      <div className="space-y-2">
                        <Select value={member.role} disabled={busy}
                          onValueChange={value => void run(() => updateTeamMember(member.id, { role: value as TeamInvite['role'] }), 'Papel atualizado.')}>
                          <SelectTrigger aria-label={`Papel de ${member.name}`} className="w-auto min-w-44 bg-surface"><SelectValue /></SelectTrigger>
                          <SelectContent>{assignableRoles.map(([r, label]) => <SelectItem key={r} value={r}>{label}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-3">
                        <Switch aria-label={`Assento de ${member.name}`} checked={member.inbox_seat} disabled={busy}
                          onCheckedChange={checked => void run(() => updateTeamMember(member.id, { inbox_seat: checked }), 'Assento atualizado.')} />
                        <span className="text-xs text-text-muted">{member.inbox_seat ? 'Habilitado' : 'Sem assento'}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                        {owner ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setConfirmation(''); setTransfer(member); setError('') }}>Transferir propriedade</Button> : null}
                        {!member.is_current ? <Button variant="ghost" size="sm" className="text-danger" disabled={busy} onClick={() => { setRemoval(member); setError('') }}>Remover da equipe</Button> : null}
                      </div>
                    </div> : null}
                  </div>
                })}
              </div>
            })}
          </div>
        </SettingsCard>
        <p className="text-xs text-text-muted">Um assento habilita o membro como responsável pelas conversas da caixa de entrada.</p>
        <AccessRequests />
        {snapshot.invites.length > 0 && <div className="rounded-lg border border-border bg-surface p-5"><h3 className="mb-4 font-semibold">Convites pendentes</h3><ul className="divide-y divide-border">{snapshot.invites.map(invite => <li key={invite.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"><div className="min-w-0"><p className="break-all text-sm">{invite.email}</p><p className="text-xs text-text-muted">{teamRoleLabels[invite.role]} · Vence em {new Date(invite.expires_at).toLocaleString('pt-BR')}</p></div>
          {canManage && <div className="flex flex-wrap items-center gap-1">
            <Button variant="secondary" size="sm" disabled={busy} aria-label={`Copiar link do convite de ${invite.email}`} onClick={() => void copyInviteLink(invite)}><Copy className="size-4" aria-hidden="true" />Copiar link</Button>
            <Button variant="ghost" size="sm" className="text-danger" disabled={busy} aria-label={`Cancelar convite de ${invite.email}`} onClick={() => void run(() => cancelTeamInvite(invite.id), 'Convite cancelado.')}>Cancelar convite</Button>
          </div>}</li>)}</ul></div>}
      </>}
    <SettingsRows><SettingsRow label="Segurança do seu acesso" help="Saia desta sessão e de todos os outros dispositivos conectados à sua conta."><Button variant="secondary" onClick={() => setLogoutOpen(true)}><LogOut className="size-4" aria-hidden="true" />Encerrar todas as sessões</Button></SettingsRow></SettingsRows>

    <Dialog open={inviteOpen} onOpenChange={open => { if (!busy) setInviteOpen(open) }}><DialogContent><DialogHeader><DialogTitle>{issued ? 'Convite pronto' : 'Convidar para a equipe'}</DialogTitle><DialogDescription>O link vence em 24 horas e só pode ser usado uma vez.</DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {issued ? <div className="space-y-4"><p className="text-sm text-text-muted">A pessoa precisa entrar com o mesmo e-mail do convite e ter o endereço confirmado.</p><div className="space-y-2"><Label htmlFor="team-invite-link">Link do convite</Label><Input id="team-invite-link" readOnly value={issued.url} onFocus={event => event.target.select()} /></div><DialogFooter><Button variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(issued.url); toast.success('Link copiado.') } catch { toast.error('Selecione o link para copiar pelo teclado.') } }}><Copy aria-hidden="true" className="size-4" />Copiar link</Button><Button onClick={() => setInviteOpen(false)}>Concluir</Button></DialogFooter></div> : <form className="space-y-5" onSubmit={async event => {
        event.preventDefault(); const form = new FormData(event.currentTarget)
        await run(async () => setIssued(await inviteTeamMember(String(form.get('email')).trim(), form.get('role') as TeamInvite['role'])), 'Convite gerado.')
      }}><div className="space-y-2"><Label htmlFor="team-invite-email">E-mail da pessoa</Label><Input id="team-invite-email" name="email" type="email" required maxLength={254} placeholder="pessoa@exemplo.com" /></div><div className="space-y-2"><Label htmlFor="team-invite-role">Papel do convite</Label><select id="team-invite-role" name="role" className={`${field} h-10`} defaultValue="editor">{assignableRoles.map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select></div><DialogFooter><Button type="button" variant="secondary" disabled={busy} onClick={() => setInviteOpen(false)}>Cancelar</Button><Button type="submit" loading={busy}>Gerar convite</Button></DialogFooter></form>}
    </DialogContent></Dialog>
    <Dialog open={!!removal} onOpenChange={open => { if (!open && !busy) setRemoval(null) }}><DialogContent><DialogHeader><DialogTitle>Remover da equipe?</DialogTitle><DialogDescription>{removal?.name} ({removal?.email}) perde o acesso a este espaço agora. As conversas atribuídas a essa pessoa ficam sem responsável. Para voltar, ela precisa de um convite novo.</DialogDescription></DialogHeader>{error && <p role="alert" className="text-sm text-danger">{error}</p>}<DialogFooter><Button variant="secondary" disabled={busy} onClick={() => setRemoval(null)}>Cancelar</Button><Button variant="danger" loading={busy} onClick={async () => { if (removal && await run(() => removeTeamMember(removal.id), 'Membro removido da equipe.')) { setRemoval(null); setEditing(null) } }}>Remover da equipe</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!transfer} onOpenChange={open => { if (!open && !busy) setTransfer(null) }}><DialogContent><DialogHeader><DialogTitle>Transferir propriedade</DialogTitle><DialogDescription>{transfer?.name} será o único proprietário deste espaço. Seu papel mudará para Administrador.</DialogDescription></DialogHeader>{error && <p role="alert" className="text-sm text-danger">{error}</p>}<div className="space-y-2"><Label htmlFor="team-transfer-confirmation">Digite TRANSFERIR</Label><Input id="team-transfer-confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" /></div><DialogFooter><Button variant="secondary" disabled={busy} onClick={() => setTransfer(null)}>Cancelar</Button><Button variant="danger" disabled={confirmation !== 'TRANSFERIR'} loading={busy} onClick={async () => { if (transfer && await run(() => transferTeamOwnership(transfer.id, confirmation), 'Propriedade transferida.')) setTransfer(null) }}>Confirmar transferência</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={logoutOpen} onOpenChange={open => !busy && setLogoutOpen(open)}><DialogContent><DialogHeader><DialogTitle>Encerrar todas as sessões?</DialogTitle><DialogDescription>Você precisará entrar novamente em todos os dispositivos, incluindo este.</DialogDescription></DialogHeader>{error && <p role="alert" className="text-sm text-danger">{error}</p>}<DialogFooter><Button variant="secondary" disabled={busy} onClick={() => setLogoutOpen(false)}>Cancelar</Button><Button variant="danger" loading={busy} onClick={async () => { setBusy(true); setError(''); try { await signOutEverywhere(); resetWorkspaceContext(); window.location.replace('/login') } catch { setError('Não foi possível encerrar as sessões. Tente novamente.'); setBusy(false) } }}>Encerrar sessões</Button></DialogFooter></DialogContent></Dialog>
  </section>
}

/** Pedidos de acesso de quem tem conta mas ainda não é membro: aprovar (com papel) ou recusar. */
function AccessRequests() {
  const { data, reload } = useAsync(listAccessRequests, 'access-requests')
  const [roles, setRoles] = useState<Record<string, TeamInvite['role']>>({})
  if (!data?.length) return null
  const act = (p: Promise<unknown>, ok: string) => p.then(() => { toast.success(ok); reload() }).catch((e: Error) => toast.error(e.message))
  return <div className="rounded-lg border border-border bg-surface p-5"><h3 className="mb-4 font-semibold">Pedidos de acesso</h3>
    <ul className="divide-y divide-border">{data.map(r => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0"><p className="break-all text-sm">{r.name ? `${r.name} · ` : ''}{r.email}</p>{r.message && <p className="text-xs text-text-muted">{r.message}</p>}</div>
      <div className="flex items-center gap-2">
        <Select value={roles[r.id] ?? 'viewer'} onValueChange={value => setRoles({ ...roles, [r.id]: value as TeamInvite['role'] })}>
          <SelectTrigger aria-label="Papel" className="w-auto min-w-44"><SelectValue /></SelectTrigger>
          <SelectContent>{(['administrator', 'editor', 'livechat_agent', 'viewer'] as const).map(k => <SelectItem key={k} value={k}>{teamRoleLabels[k]}</SelectItem>)}</SelectContent>
        </Select>
        <Button size="sm" onClick={() => act(approveAccessRequest(r.id, roles[r.id] ?? 'viewer'), 'Acesso aprovado.')}>Aprovar</Button>
        <Button size="sm" variant="ghost" onClick={() => act(denyAccessRequest(r.id), 'Pedido recusado.')}>Recusar</Button>
      </div></li>)}</ul></div>
}
