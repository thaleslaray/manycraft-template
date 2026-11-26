import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { AlertTriangle, PlugZap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ApiError, apiRequest } from '@/data/api'
import { camposDaAprovacao, camposDaRecusa, enviarAoConector, lerPedido, NOME_DA_CHAVE, pedidoValido, pendingConsentKey, type PedidoDeConexao } from '@/data/conector'
import { createProfileKey, scopeLabel, type ProfileKeyScope } from '@/data/profile-keys'

type Espaco = { id: string; name: string }
type Carga = { estado: 'carregando' } | { estado: 'erro'; mensagem: string } | { estado: 'pronto'; pedido: Extract<PedidoDeConexao, { estado: 'ok' }>; espacos: Espaco[]; atual: string }

const guardar = (pedido: string | null) => { try { if (pedido) sessionStorage.setItem(pendingConsentKey, pedido); else sessionStorage.removeItem(pendingConsentKey) } catch { /* sem armazenamento: o login só não volta para cá */ } }

/** Tela de consentimento: um aplicativo (o Claude) pede acesso à conta. Fica atrás do login; o pedido sobrevive ao login. */
export function ConnectPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const pedido = params.get('pedido')
  const [carga, setCarga] = useState<Carga>({ estado: 'carregando' })
  const [espaco, setEspaco] = useState('')
  const [escopo, setEscopo] = useState<ProfileKeyScope>('read')
  const [irreversiveis, setIrreversiveis] = useState(false)
  const [enviando, setEnviando] = useState<'aprovar' | 'cancelar' | null>(null)
  const [erro, setErro] = useState('')

  useEffect(() => {
    if (!pedidoValido(pedido)) { guardar(null); setCarga({ estado: 'erro', mensagem: 'Este endereço de conexão está incompleto. Volte ao aplicativo e peça a conexão de novo.' }); return }
    guardar(pedido)
    let vivo = true
    void (async () => {
      let lista: { current: string; items: Espaco[] }
      try { lista = await apiRequest<{ current: string; items: Espaco[] }>('/workspaces/mine') }
      catch (causa) {
        if (causa instanceof ApiError && causa.status === 401) { navigate('/login', { replace: true }); return }
        if (vivo) setCarga({ estado: 'erro', mensagem: 'Não foi possível carregar seus espaços. Tente de novo em instantes.' })
        return
      }
      const lido = await lerPedido(pedido)
      if (!vivo) return
      if (lido.estado === 'vencido') { guardar(null); setCarga({ estado: 'erro', mensagem: 'Este pedido de conexão venceu ou já foi usado. Os pedidos valem por 10 minutos: volte ao aplicativo e conecte de novo.' }); return }
      if (lido.estado === 'indisponivel') { setCarga({ estado: 'erro', mensagem: 'Não foi possível falar com o conector do ManyCraft agora. Tente de novo em instantes.' }); return }
      setEspaco(lista.items.some(item => item.id === lista.current) ? lista.current : lista.items[0]?.id ?? '')
      setCarga({ estado: 'pronto', pedido: lido, espacos: lista.items, atual: lista.current })
    })()
    return () => { vivo = false }
  }, [pedido, navigate])

  async function aprovar() {
    if (!pedido || !espaco) return
    setEnviando('aprovar'); setErro('')
    try {
      const chave = await createProfileKey(NOME_DA_CHAVE, escopo)
      guardar(null)
      enviarAoConector(camposDaAprovacao({ pedido, token: chave.token, workspace: espaco, escopo, irreversiveis }))
    } catch (causa) {
      setErro(causa instanceof Error ? causa.message : 'Não foi possível criar a chave de acesso.')
      setEnviando(null)
    }
  }

  function cancelar() {
    if (!pedido) return
    setEnviando('cancelar')
    guardar(null)
    enviarAoConector(camposDaRecusa(pedido))
  }

  return <main className="grid min-h-dvh place-items-center bg-surface p-6 text-text">
    <title>Conectar aplicativo · ManyCraft</title>
    <section aria-labelledby="connect-title" className="w-full max-w-md space-y-6 rounded-lg border border-border p-6 sm:p-8">
      <PlugZap className="size-10 text-text-muted" aria-hidden="true" />
      {carga.estado === 'carregando' ? <p role="status">Conferindo o pedido de conexão…</p>
        : carga.estado === 'erro' ? <div className="space-y-3"><h1 id="connect-title" className="text-2xl font-bold">Não foi possível conectar</h1><p role="alert" className="rounded-md border border-danger p-3 text-sm text-danger">{carga.mensagem}</p></div>
        : <>
          <div className="space-y-3">
            <h1 id="connect-title" className="text-2xl font-bold">Conectar <span className="break-words">{carga.pedido.cliente}</span></h1>
            <p className="text-sm leading-6 text-text-muted">
              <strong className="font-semibold text-text">{carga.pedido.cliente}</strong> quer acessar sua conta do ManyCraft. O acesso vai para <strong className="font-semibold text-text">{carga.pedido.destino}</strong>.{' '}
              {carga.pedido.dominio ? <>Publicado por <strong className="font-semibold text-text">{carga.pedido.dominio}</strong>.</> : 'O nome foi informado pelo próprio aplicativo.'}
            </p>
            {carga.pedido.local && <p role="note" className="flex gap-2 rounded-md bg-warning-soft p-3 text-sm text-warning"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />O acesso vai para um programa neste computador. Continue só se você acabou de pedir a conexão nele.</p>}
          </div>
          {erro && <p role="alert" className="rounded-md border border-danger p-3 text-sm text-danger">{erro}</p>}
          <fieldset disabled={enviando !== null} className="space-y-5">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Espaço de trabalho</legend>
              {carga.espacos.length ? <div className="space-y-2 text-sm">
                {carga.espacos.map(item => <label key={item.id} className="flex items-center gap-2"><input type="radio" name="connect-workspace" className="size-4 accent-accent" checked={espaco === item.id} onChange={() => setEspaco(item.id)} />{item.name}</label>)}
              </div> : <p className="text-sm text-text-muted">Você ainda não participa de nenhum espaço.</p>}
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">O que o aplicativo pode fazer</legend>
              <div className="flex flex-wrap gap-4 text-sm">
                {(['read', 'write'] as const).map(value => <label key={value} className="flex items-center gap-2"><input type="radio" name="connect-scope" className="size-4 accent-accent" checked={escopo === value} onChange={() => { setEscopo(value); if (value === 'read') setIrreversiveis(false) }} />{value === 'read' ? scopeLabel('read') : 'Ler e escrever'}</label>)}
              </div>
            </fieldset>
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox className="mt-0.5" checked={irreversiveis} disabled={escopo === 'read'} onCheckedChange={value => setIrreversiveis(value === true)} aria-describedby="connect-irreversible-help" />
                <span>Permitir ações sem volta (apagar, enviar mensagens, mexer em conexões)</span>
              </label>
              <p id="connect-irreversible-help" className="pl-7 text-xs leading-5 text-text-muted">{escopo === 'read' ? 'Só vale com "Ler e escrever".' : 'Com isto marcado, o aplicativo pode apagar dados e mandar mensagens aos seus contatos sem outra confirmação aqui. Deixe desmarcado se não tiver certeza.'}</p>
            </div>
            <p className="text-xs leading-5 text-text-muted">Vamos criar a chave "{NOME_DA_CHAVE}" no seu perfil. Para desligar o acesso, revogue essa chave em Configurações, na aba API.</p>
            <div className="space-y-3">
              <Button className="w-full" disabled={!espaco} loading={enviando === 'aprovar'} onClick={aprovar}>Aprovar</Button>
              <Button variant="secondary" className="w-full" loading={enviando === 'cancelar'} onClick={cancelar}>Cancelar</Button>
            </div>
          </fieldset>
        </>}
    </section>
  </main>
}
