// A sessão do pedido, lida UMA vez, e a regra de quando o cache em cookie do Better Auth vale.
//
// O Better Auth guarda a sessão num cookie assinado (`session_data`, `session.cookieCache` em
// auth.ts, 60 s): com ele o `getSession` não vai ao D1 (que fica a um continente do Worker, cada
// ida em fila custa uma viagem de rede). O preço é o atraso: sessão encerrada (sair de todos os
// aparelhos, redefinir senha, excluir conta) segue valendo nas LEITURAS comuns por até 60 s.
// Por isso o cache só vale para GET/HEAD fora da lista de rotas sensíveis; toda escrita, toda rota
// sensível e todo upgrade de WebSocket leem a sessão do banco (`disableCookieCache`). O papel do
// membro no espaço nunca vem do cache: é lido no D1 a cada pedido (remover membro corta na hora).
import type { Env } from './env'
import { createAuth } from './auth'

/** Leituras que mostram ou mexem em equipe, acesso, chaves, contas e conexões de canal: sempre sessão do banco. */
export const SENSITIVE_READ_PREFIXES = [
  'team', 'workspaces', 'invites', 'access-requests', 'agency', 'account', 'me', 'profile',
  'api-keys', 'connections', 'email', 'activity-log', 'compliance', 'workspace-settings',
  'apps', 'hotmart', 'google-sheets', 'pixel', 'site-widgets', 'meta-review',
]
const SENSITIVE_READ = new RegExp(`^/api/(?:${SENSITIVE_READ_PREFIXES.join('|')})(?:/|$)`)

/** O cache do cookie só serve a leitura comum: GET/HEAD, sem upgrade, fora das rotas sensíveis. */
export function mayUseSessionCache(method: string, path: string, upgrade?: string | null) {
  return (method === 'GET' || method === 'HEAD') && !upgrade && !SENSITIVE_READ.test(path)
}

type Session = Awaited<ReturnType<ReturnType<typeof createAuth>['api']['getSession']>>
type Lidas = { cache?: Promise<Session>; banco?: Promise<Session>; cookies: string[] }
const porPedido = new WeakMap<Request, Lidas>()

/** Sessão do pedido. `cache: false` lê do banco (a leitura do banco também atende quem aceitaria o cache). */
export function requestSession(env: Env, request: Request, cache: boolean): Promise<Session> {
  const lidas = porPedido.get(request) ?? { cookies: [] }
  porPedido.set(request, lidas)
  if (lidas.banco) return lidas.banco
  if (cache && lidas.cache) return lidas.cache
  // returnHeaders: o Better Auth prepara aqui o cookie de cache (session_data) e a renovação da sessão;
  // sem repassá-los ao navegador o cache nunca nasce fora do login e cada pedido iria ao banco.
  const leitura = createAuth(env).api.getSession({ headers: request.headers, returnHeaders: true, ...cache ? {} : { query: { disableCookieCache: true } } })
    .then(({ headers, response }) => { lidas.cookies.push(...headers.getSetCookie()); return response })
  if (cache) lidas.cache = leitura; else lidas.banco = leitura
  return leitura
}

/** Cookies de sessão que a leitura deste pedido preparou (cache de 60 s, renovação), para a resposta levar ao navegador. */
export function sessionCookies(request: Request): string[] {
  return porPedido.get(request)?.cookies ?? []
}
