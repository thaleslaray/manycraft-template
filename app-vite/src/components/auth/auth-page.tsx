import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, Check, Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { authErrorMessage, authRequest, CODIGO_TAMANHO, entrarComCodigo, entrarComoTeste, limparCodigo, pedirCodigo, precisaDeCodigoNovo, resetWorkspaceContext } from '@/data/auth'
import { pendingInviteKey, previewInvite } from '@/data/team'
import { destinoDepoisDoLogin } from '@/data/conector'
import { clearAsyncCache } from '@/hooks/use-async'

/** Espera para pedir outro código (o motor também limita pedidos por e-mail e por IP). */
const ESPERA_REENVIO_S = 60

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

function ErrorBox({ id, children }: { id: string; children: ReactNode }) {
  return <p id={id} role="alert" className="rounded-md border border-danger p-3 text-sm text-danger">{children}</p>
}

/** Entrada em duas etapas: e-mail, depois o código de 6 dígitos que chega nele. Quem tem convite e ainda não tem conta entra igual. */
export function AuthPage() {
  const navigate = useNavigate()
  const [etapa, setEtapa] = useState<'email' | 'codigo'>('email')
  const [email, setEmail] = useState('')
  const [codigo, setCodigo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // Código esgotado (tentativas) ou vencido: o campo trava e só um código novo entra.
  const [codigoBloqueado, setCodigoBloqueado] = useState(false)
  const [reenvioEm, setReenvioEm] = useState(0)
  const [agora, setAgora] = useState(() => Date.now())
  const emailRef = useRef<HTMLInputElement>(null)
  const codigoRef = useRef<HTMLInputElement>(null)
  const reenviarRef = useRef<HTMLButtonElement>(null)
  const enviando = useRef(false)

  // Convite aberto antes da entrada: o e-mail do convite já vem preenchido.
  const [inviteEmail, setInviteEmail] = useState('')
  useEffect(() => {
    const pending = sessionStorage.getItem(pendingInviteKey)
    if (!pending) return
    let live = true
    void previewInvite(pending).then(address => { if (live && address) { setInviteEmail(address); setEmail(current => current || address) } }).catch(() => {})
    return () => { live = false }
  }, [])

  // Contagem do reenvio: um tique por segundo só enquanto falta tempo.
  const faltam = Math.max(0, Math.ceil((reenvioEm - agora) / 1000))
  useEffect(() => {
    if (reenvioEm <= Date.now()) return
    const timer = window.setInterval(() => { const now = Date.now(); setAgora(now); if (now >= reenvioEm) window.clearInterval(timer) }, 1000)
    return () => window.clearInterval(timer)
  }, [reenvioEm])

  // Foco no campo certo a cada troca de etapa ou erro novo.
  useEffect(() => {
    if (etapa === 'email') emailRef.current?.focus()
    else if (codigoBloqueado) reenviarRef.current?.focus()
    else codigoRef.current?.focus()
  }, [etapa, error, codigoBloqueado])

  function comecarEspera() { const now = Date.now(); setAgora(now); setReenvioEm(now + ESPERA_REENVIO_S * 1000) }

  async function enviarCodigo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(''); setNotice(''); setBusy(true)
    try {
      const address = email.trim()
      await pedirCodigo(address)
      setEmail(address); setCodigo(''); setCodigoBloqueado(false); comecarEspera(); setEtapa('codigo')
    } catch (cause) { setError(authErrorMessage(cause)) }
    finally { setBusy(false) }
  }

  async function reenviar() {
    setError(''); setNotice(''); setBusy(true)
    try {
      await pedirCodigo(email)
      setCodigo(''); setCodigoBloqueado(false); comecarEspera()
      setNotice('Enviamos um código novo. O anterior deixou de valer.')
    } catch (cause) { setError(authErrorMessage(cause)) }
    finally { setBusy(false) }
  }

  async function entrar(valor: string) {
    if (enviando.current || valor.length !== CODIGO_TAMANHO) return
    enviando.current = true
    setError(''); setNotice(''); setBusy(true)
    try {
      await entrarComCodigo(email, valor)
      resetWorkspaceContext(); clearAsyncCache()
      navigate(destinoDepoisDoLogin(), { replace: true })
    } catch (cause) {
      setCodigo('')
      if (precisaDeCodigoNovo(cause)) { setCodigoBloqueado(true); setReenvioEm(0) }
      setError(authErrorMessage(cause))
    } finally { enviando.current = false; setBusy(false) }
  }

  function trocarEmail() {
    setEtapa('email'); setCodigo(''); setError(''); setNotice(''); setCodigoBloqueado(false)
  }

  // Só no servidor de desenvolvimento: entra como dona do espaço de desenvolvimento (a Lia do seed, engine/scripts/seed.sql)
  // por uma rota do motor que só existe lá (POST /api/dev/sign-in; 404 fora do desenvolvimento). Sem senha e sem e-mail.
  async function enterAsTestUser() {
    setError(''); setBusy(true)
    try {
      await entrarComoTeste()
      resetWorkspaceContext(); clearAsyncCache()
      navigate(destinoDepoisDoLogin(), { replace: true })
    } catch (cause) { setError(authErrorMessage(cause)) }
    finally { setBusy(false) }
  }

  if (etapa === 'email') return <AuthFrame>
    <title>Acesse seu espaço · ManyCraft</title>
    <div className="mb-7 space-y-3">
      <h1 id="auth-title" className="text-3xl font-bold tracking-tight">Acesse seu espaço</h1>
      <p className="text-sm leading-6 text-text-muted">Digite seu e-mail. Enviamos um código de acesso para você entrar, sem senha.</p>
    </div>
    <form onSubmit={enviarCodigo} className="space-y-5">
      <fieldset disabled={busy} className="space-y-5">
        <legend className="sr-only">Entrar com o e-mail</legend>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="email">E-mail</label>
          <Input ref={emailRef} id="email" name="email" type="email" autoComplete="email" required maxLength={254} value={email}
            onChange={event => setEmail(event.target.value)} placeholder="voce@exemplo.com" className="h-12 text-base"
            aria-invalid={error ? true : undefined} aria-describedby={error ? 'email-erro' : inviteEmail ? 'email-convite' : undefined} />
          {inviteEmail && email.trim().toLowerCase() === inviteEmail.toLowerCase() && <p id="email-convite" className="text-xs text-text-muted">Este é o e-mail do seu convite.</p>}
        </div>
        {error && <ErrorBox id="email-erro">{error}</ErrorBox>}
        <Button type="submit" loading={busy} className="w-full" size="lg">Enviar código</Button>
      </fieldset>
    </form>
    {import.meta.env.DEV && <Button type="button" variant="secondary" size="lg" className="mt-4 w-full" disabled={busy} onClick={enterAsTestUser}>Entrar (teste)</Button>}
    <SocialButtons onError={setError} />
  </AuthFrame>

  return <AuthFrame>
    <title>Digite o código · ManyCraft</title>
    <div className="mb-7 space-y-3">
      <Mail className="mb-6 size-10 text-text-muted" aria-hidden="true" />
      <h1 id="auth-title" className="text-3xl font-bold tracking-tight">Digite o código</h1>
      <p className="text-sm leading-6 text-text-muted">
        Enviamos um código de 6 dígitos para <strong className="break-all font-semibold text-text">{email}</strong>. Se este e-mail puder entrar, o código chega em instantes. Ele vale por 10 minutos.
      </p>
    </div>
    {notice && <p role="status" className="mb-5 flex gap-2 rounded-md bg-success-soft p-3 text-sm text-success"><Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{notice}</p>}
    <form onSubmit={event => { event.preventDefault(); void entrar(codigo) }} className="space-y-5">
      <fieldset disabled={busy} className="space-y-5">
        <legend className="sr-only">Entrar com o código</legend>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="codigo">Código de acesso</label>
          {/* Sem maxLength: colar "123 456" ou "123-456" precisa chegar inteiro para a limpeza tirar o separador. */}
          <Input ref={codigoRef} id="codigo" name="codigo" type="text" inputMode="numeric" autoComplete="one-time-code" required
            value={codigo} disabled={codigoBloqueado} placeholder="000000" data-testid="campo-codigo"
            onChange={event => { const limpo = limparCodigo(event.target.value); setCodigo(limpo); if (limpo.length === CODIGO_TAMANHO) void entrar(limpo) }}
            className="h-12 text-center font-mono text-2xl tracking-[0.5em]"
            aria-invalid={error ? true : undefined} aria-describedby={error ? 'codigo-erro' : 'codigo-ajuda'} />
          <p id="codigo-ajuda" className="text-xs text-text-muted">Confira também a caixa de spam. Pode colar o código inteiro.</p>
        </div>
        {error && <ErrorBox id="codigo-erro">{error}</ErrorBox>}
        <Button type="submit" loading={busy} disabled={codigoBloqueado || codigo.length !== CODIGO_TAMANHO} className="w-full" size="lg">Entrar</Button>
      </fieldset>
    </form>
    <div className="mt-5 flex flex-col items-center gap-3">
      <Button ref={reenviarRef} type="button" variant={codigoBloqueado ? 'primary' : 'secondary'} size="lg" className="w-full"
        disabled={busy || faltam > 0} onClick={() => void reenviar()}>
        {codigoBloqueado ? 'Pedir código novo' : faltam > 0 ? `Reenviar código em ${faltam} s` : 'Reenviar código'}
      </Button>
      {/* A contagem do botão não é anunciada a cada segundo; o leitor de tela só ouve quando o reenvio libera. */}
      <span role="status" className="sr-only">{!codigoBloqueado && reenvioEm > 0 && faltam === 0 ? 'Você já pode pedir outro código.' : ''}</span>
      <button type="button" onClick={trocarEmail} disabled={busy} className="mt-2 flex items-center justify-center gap-2 text-sm font-medium hover:underline disabled:opacity-50">
        <ArrowLeft className="size-4" aria-hidden="true" />Usar outro e-mail
      </button>
    </div>
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
  // O divisor "ou" mora aqui: sem Google configurado ele ficava solto, sem nada embaixo.
  return <div className="mb-3 space-y-3">
    <div className="my-6 flex items-center gap-4 text-xs text-text-muted"><span className="h-px flex-1 bg-border" />ou<span className="h-px flex-1 bg-border" /></div>
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
