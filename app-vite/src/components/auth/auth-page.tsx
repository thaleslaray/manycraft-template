import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { ArrowLeft, Check, Eye, EyeOff, KeyRound, Mail, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { authErrorMessage, authRequest, authURL, resetWorkspaceContext } from '@/data/auth'
import { pendingInviteKey, previewInvite } from '@/data/team'

type Mode = 'login' | 'signup' | 'verify' | 'forgot' | 'reset' | 'magic'
const titles: Record<Mode, string> = {
  login: 'Acesse seu espaço', signup: 'Crie sua conta', verify: 'Confira seu e-mail',
  forgot: 'Recupere seu acesso', reset: 'Defina uma nova senha', magic: 'Entre com um link seguro',
}
const descriptions: Record<Mode, string> = {
  login: 'Continue de onde parou nas suas conversas.', signup: 'Organize suas conversas e automações em um só lugar.',
  verify: 'Abra o link de confirmação que enviamos para liberar sua conta.',
  forgot: 'Informe seu e-mail para receber as instruções de recuperação.',
  reset: 'Escolha uma senha com pelo menos 12 caracteres.', magic: 'Receba um link de acesso no e-mail, sem digitar sua senha.',
}

function PasswordField({ label, id, value, onChange, autoComplete }: {
  label: string; id: string; value: string; onChange(value: string): void; autoComplete: string
}) {
  const [visible, setVisible] = useState(false)
  return <div className="space-y-2">
    <label className="text-sm font-medium" htmlFor={id}>{label}</label>
    <div className="relative">
      <Input id={id} name={id} type={visible ? 'text' : 'password'} required minLength={12} maxLength={128}
        autoComplete={autoComplete} value={value} onChange={event => onChange(event.target.value)} className="h-12 pr-12 text-base" />
      <button type="button" aria-label={visible ? `Ocultar ${label.toLowerCase()}` : `Mostrar ${label.toLowerCase()}`}
        aria-pressed={visible} onClick={() => setVisible(!visible)} className="absolute inset-y-0 right-0 grid w-12 place-items-center rounded-md text-text-muted">
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  </div>
}

function AuthFrame({ children }: { children: ReactNode }) {
  return <main className="flex min-h-dvh flex-col bg-surface text-text">
    <header className="flex items-center gap-2 px-6 py-7 sm:px-10">
      <img src="/logo.svg" alt="" className="size-8" /><span className="text-lg font-bold tracking-tight">ManyCraft</span>
    </header>
    <div className="flex flex-1 items-center justify-center px-6 pb-10 sm:pb-24">
      <section className="w-full max-w-[400px]" aria-labelledby="auth-title">{children}</section>
    </div>
    <footer className="px-6 pb-6 text-center text-xs text-text-muted">Seu espaço de conversas e automações.</footer>
  </main>
}

export function AuthPage({ mode }: { mode: Mode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const [email, setEmail] = useState<string>(location.state?.email ?? '')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // Convite aberto antes do cadastro: o e-mail do convite já vem preenchido (no cadastro, travado, para a conta casar com o convite).
  const [inviteEmail, setInviteEmail] = useState('')
  useEffect(() => {
    const pending = mode === 'signup' || mode === 'login' ? sessionStorage.getItem(pendingInviteKey) : null
    if (!pending) return
    let live = true
    void previewInvite(pending).then(address => { if (live && address) { setInviteEmail(address); setEmail(current => current || address) } }).catch(() => {})
    return () => { live = false }
  }, [mode])
  const token = params.get('token')
  const invalidLink = params.has('error') || (mode === 'reset' && !token)
  const message = notice || (params.get('verified') === '1' ? 'E-mail confirmado. Agora você pode entrar.'
    : params.get('reset') === '1' ? 'Senha atualizada. Entre com sua nova senha.' : '')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(''); setNotice('')
    if (mode === 'reset' && password !== confirmation) { setError('As senhas precisam ser iguais.'); return }
    setBusy(true)
    try {
      const address = email.trim()
      if (mode === 'signup') {
        await authRequest('sign-up/email', { name: name.trim(), email: address, password, callbackURL: authURL('/login?verified=1') })
        navigate('/verify-email', { state: { email: address } })
      } else if (mode === 'login') {
        await authRequest('sign-in/email', { email: address, password })
        resetWorkspaceContext()
        navigate(sessionStorage.getItem(pendingInviteKey) ? '/invite' : '/', { replace: true })
      } else if (mode === 'verify') {
        await authRequest('send-verification-email', { email: address, callbackURL: authURL('/login?verified=1') })
        setNotice('Se a conta precisar de confirmação, enviamos um novo link. Confira sua caixa de entrada.')
      } else if (mode === 'forgot') {
        await authRequest('request-password-reset', { email: address, redirectTo: authURL('/reset-password') })
        setNotice('Se houver uma conta com esse e-mail, você receberá as instruções de recuperação.')
      } else if (mode === 'reset') {
        await authRequest('reset-password', { token, newPassword: password })
        resetWorkspaceContext()
        navigate('/login?reset=1', { replace: true })
      } else {
        await authRequest('sign-in/magic-link', { email: address, callbackURL: authURL(sessionStorage.getItem(pendingInviteKey) ? '/invite' : '/'), errorCallbackURL: authURL('/login') })
        setNotice('Confira sua caixa de entrada. Enviamos um link de acesso para o seu e-mail.')
      }
    } catch (cause) { setError(authErrorMessage(cause)) }
    finally { setBusy(false) }
  }

  // Temporário, só no servidor de desenvolvimento: entra com a conta de teste do seed (engine/scripts/seed.sql).
  async function enterAsTestUser() {
    setError(''); setBusy(true)
    try {
      await authRequest('sign-in/email', { email: 'lia@example.test', password: 'demo-d606be70' })
      resetWorkspaceContext()
      navigate('/', { replace: true })
    } catch (cause) { setError(authErrorMessage(cause)) }
    finally { setBusy(false) }
  }

  const Icon = mode === 'verify' || mode === 'magic' ? Mail : mode === 'forgot' || mode === 'reset' ? KeyRound : ShieldCheck
  const submitLabel = { login: 'Entrar', signup: 'Criar conta', verify: 'Reenviar confirmação', forgot: 'Enviar recuperação', reset: 'Salvar nova senha', magic: 'Enviar link de acesso' }[mode]
  return <AuthFrame>
    <title>{titles[mode]} · ManyCraft</title>
    <div className="mb-7 space-y-3">
      {mode !== 'login' && mode !== 'signup' && <Icon className="mb-6 size-10 text-text-muted" aria-hidden="true" />}
      <h1 id="auth-title" className="text-3xl font-bold tracking-tight">{titles[mode]}</h1>
      <p className="text-sm leading-6 text-text-muted">{descriptions[mode]}</p>
    </div>
    {message && <p role="status" className="mb-5 flex gap-2 rounded-md bg-success-soft p-3 text-sm text-success"><Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{message}</p>}
    {(error || invalidLink) && <p role="alert" className="mb-5 rounded-md border border-danger p-3 text-sm text-danger">{error || 'Link inválido ou expirado. Solicite um novo link para continuar.'}</p>}
    <form onSubmit={submit} className="space-y-5">
      <fieldset disabled={busy || (mode === 'reset' && invalidLink)} className="space-y-5">
        <legend className="sr-only">{titles[mode]}</legend>
        {mode === 'signup' && <div className="space-y-2"><label className="text-sm font-medium" htmlFor="name">Seu nome</label>
          <Input id="name" name="name" autoComplete="name" required maxLength={120} value={name} onChange={event => setName(event.target.value)} className="h-12 text-base" /></div>}
        {mode !== 'reset' && <div className="space-y-2"><label className="text-sm font-medium" htmlFor="email">E-mail</label>
          <Input id="email" name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} readOnly={mode === 'signup' && !!inviteEmail} placeholder="voce@exemplo.com" className="h-12 text-base" />
          {mode === 'signup' && inviteEmail && <p className="text-xs text-text-muted">Este convite vale para este e-mail.</p>}</div>}
        {(mode === 'login' || mode === 'signup' || mode === 'reset') && <PasswordField label={mode === 'reset' ? 'Nova senha' : 'Senha'} id="password" value={password} onChange={setPassword} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />}
        {mode === 'signup' && <p className="-mt-3 text-xs text-text-muted">Use pelo menos 12 caracteres para proteger sua conta.</p>}
        {mode === 'reset' && <PasswordField label="Repita a nova senha" id="confirmation" value={confirmation} onChange={setConfirmation} autoComplete="new-password" />}
        {mode === 'login' && <div className="text-right"><Link to="/forgot-password" className="text-sm font-medium underline-offset-4 hover:underline">Esqueci minha senha</Link></div>}
        <Button type="submit" loading={busy} className="w-full" size="lg">{submitLabel}</Button>
      </fieldset>
    </form>
    {mode === 'login' && <>
      {import.meta.env.DEV && <Button type="button" variant="secondary" size="lg" className="mt-4 w-full" disabled={busy} onClick={enterAsTestUser}>Entrar (teste)</Button>}
      {error && <Link to="/verify-email" state={{ email }} className="mt-4 block text-center text-sm underline">Pedir novo link de confirmação</Link>}
      <div className="my-6 flex items-center gap-4 text-xs text-text-muted"><span className="h-px flex-1 bg-border" />ou<span className="h-px flex-1 bg-border" /></div>
      <SocialButtons onError={setError} />
      <Button asChild variant="secondary" size="lg" className="w-full"><Link to="/magic-link"><Mail className="size-4" />Entrar por link no e-mail</Link></Button>
      <p className="mt-8 text-center text-sm text-text-muted">Primeira vez aqui? <Link to="/signup" className="font-semibold text-text underline-offset-4 hover:underline">Criar conta</Link></p>
    </>}
    {mode !== 'login' && <Link to="/login" className="mt-7 flex items-center justify-center gap-2 text-sm font-medium hover:underline"><ArrowLeft className="size-4" aria-hidden="true" />Voltar para a entrada</Link>}
    {mode === 'reset' && invalidLink && <Link to="/forgot-password" className="mt-4 block text-center text-sm underline">Pedir nova recuperação</Link>}
  </AuthFrame>
}

/** Entrar com Google: só aparece quando o provedor está configurado no motor. */
function SocialButtons({ onError }: { onError: (message: string) => void }) {
  const [providers, setProviders] = useState<{ google: boolean; google_client_id?: string | null }>({ google: false })
  useEffect(() => { fetch('/api/session/providers', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(p => p && setProviders(p)).catch(() => {}) }, [])
  useOneTap(providers.google_client_id ?? null, onError)
  async function start(provider: 'google') {
    try {
      const result = await authRequest<{ url?: string }>('sign-in/social', { provider, callbackURL: '/' })
      if (result.url) window.location.assign(result.url)
    } catch (e) { onError(authErrorMessage(e)) }
  }
  if (!providers.google) return null
  return <div className="mb-3 space-y-3">
    {providers.google ? <Button variant="secondary" size="lg" className="w-full" onClick={() => void start('google')}>Entrar com Google</Button> : null}
  </div>
}

type GoogleId = { accounts: { id: { initialize(o: { client_id: string; callback(r: { credential: string }): void; auto_select?: boolean; cancel_on_tap_outside?: boolean }): void; prompt(): void } } }
/** Google One Tap: o cartão de entrada do Google aparece sozinho; o token vai ao motor, que cria a conta ou entra. */
function useOneTap(clientId: string | null, onError: (message: string) => void) {
  useEffect(() => {
    if (!clientId) return
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true
    script.onload = () => {
      const google = (window as unknown as { google?: GoogleId }).google
      google?.accounts.id.initialize({ client_id: clientId, cancel_on_tap_outside: true, callback: async ({ credential }) => {
        try { await authRequest('one-tap/callback', { idToken: credential }); window.location.assign('/') } catch (e) { onError(authErrorMessage(e)) }
      } })
      google?.accounts.id.prompt()
    }
    document.head.appendChild(script)
    return () => { script.remove() }
  }, [clientId, onError])
}
