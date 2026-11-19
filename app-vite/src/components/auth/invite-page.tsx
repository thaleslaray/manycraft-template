import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ArrowRight, Users } from 'lucide-react'
import { useAsync } from '@/hooks/use-async'
import { authRequest, resetWorkspaceContext, type Session } from '@/data/auth'
import { acceptTeamInvite, pendingInviteKey, previewInvite } from '@/data/team'
import { Button } from '@/components/ui/button'
import { clearAsyncCache } from '@/hooks/use-async'

export function InvitePage() {
  const navigate = useNavigate()
  const [token] = useState(() => {
    const value = window.location.hash.slice(1) || sessionStorage.getItem(pendingInviteKey) || ''
    if (value) sessionStorage.setItem(pendingInviteKey, value)
    return value
  })
  const invitedEmail = useAsync(() => previewInvite(token), `invite-preview-${token}`).data
  const session = useAsync(() => authRequest<Session>('get-session'), 'invite-session')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const user = session.data?.user
  return <main className="grid min-h-dvh place-items-center bg-surface p-6 text-text">
    <title>Convite para a equipe · ManyCraft</title>
    <section aria-labelledby="invite-title" className="w-full max-w-md space-y-6 rounded-lg border border-border p-6 sm:p-8">
      <Users className="size-10 text-text-muted" aria-hidden="true" />
      <div className="space-y-3"><h1 id="invite-title" className="text-2xl font-bold">Participe da equipe</h1><p className="text-sm leading-6 text-text-muted">{invitedEmail ? <>Este convite vale para <strong className="font-semibold text-text">{invitedEmail}</strong>. Entre ou crie a conta com esse e-mail.</> : 'Use sua conta com o mesmo e-mail que recebeu o convite.'} O link é válido por 24 horas e só pode ser aceito uma vez.</p></div>
      {(!token || error) && <p role="alert" className="rounded-md border border-danger p-3 text-sm text-danger">{error || 'Link de convite ausente. Peça um novo link ao administrador.'}</p>}
      {session.loading ? <p role="status">Conferindo seu acesso…</p> : session.error ? <><p role="alert" className="text-sm text-danger">Não foi possível conferir seu acesso.</p><Button variant="secondary" onClick={session.reload}>Tentar de novo</Button></> : !user?.emailVerified ? <div className="space-y-3"><Button asChild className="w-full"><Link to="/login">Entrar para continuar<ArrowRight className="size-4" aria-hidden="true" /></Link></Button><Button asChild variant="secondary" className="w-full"><Link to="/signup">Criar minha conta</Link></Button></div> : <div className="space-y-3">
        <Button className="w-full" disabled={!token} loading={busy} onClick={async () => {
          setBusy(true); setError('')
          try {
            const accepted = await acceptTeamInvite(token)
            sessionStorage.removeItem(pendingInviteKey)
            resetWorkspaceContext()
            navigate(`/${encodeURIComponent(accepted.workspace_id)}/inbox`, { replace: true })
          } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível aceitar o convite.') }
          finally { setBusy(false) }
        }}>Aceitar convite</Button>
        <Button variant="ghost" className="w-full" disabled={busy} onClick={async () => {
          setBusy(true); setError('')
          try { await authRequest('sign-out', {}); resetWorkspaceContext(); clearAsyncCache(); navigate('/login') }
          catch { setError('Não foi possível sair. Tente novamente.'); setBusy(false) }
        }}>Entrar com outra conta</Button>
      </div>}
    </section>
  </main>
}
