// Acesso por chave de perfil às rotas do painel (/api/*): a lista única do que a chave NÃO abre.
//
// A chave de perfil (`Authorization: Bearer perfil:<segredo>` + `x-workspace`) vira o mesmo `principal`
// do painel (usuário + papel real no espaço), então toda rota que passa pelo middleware de sessão vale por
// API com as mesmas permissões. Aqui ficam as exceções: ações que só a própria pessoa, logada no painel,
// deve fazer. Este módulo é usado pelo middleware (`index.ts`) e pelo inventário de rotas
// (`scripts/api-inventario.mjs`, que o importa direto em Node: sem imports).

export type BlockedRoute = { method: string; path: string; motivo: string }

/** Bloqueadas para a chave (403 "Esta ação só pode ser feita no painel."). `*` vale para qualquer método; `/*` no fim, para o prefixo. */
export const API_KEY_BLOCKED: readonly BlockedRoute[] = [
  { method: '*', path: '/api/api-keys', motivo: 'uma chave não fabrica, lê nem revoga a chave do espaço' },
  { method: '*', path: '/api/profile/*', motivo: 'uma chave não fabrica nem revoga outra chave de perfil' },
  { method: '*', path: '/api/account/*', motivo: 'conta e segurança (sair de todos os aparelhos)' },
  { method: 'POST', path: '/api/workspaces', motivo: 'criar espaço novo é ação da conta' },
  { method: 'POST', path: '/api/workspaces/clone', motivo: 'clonar cria um espaço novo de posse da conta' },
  { method: 'POST', path: '/api/workspaces/switch', motivo: 'só troca o espaço do cookie do painel' },
  { method: 'POST', path: '/api/invites/accept', motivo: 'aceitar convite liga a conta a outro espaço' },
  { method: 'POST', path: '/api/access-requests', motivo: 'pedir acesso a outro espaço em nome da conta' },
  { method: 'POST', path: '/api/team/transfer-ownership', motivo: 'transferir a posse do espaço' },
  { method: 'POST', path: '/api/team/leave', motivo: 'sair do espaço (revoga o próprio acesso)' },
  { method: 'GET', path: '/api/inbox/live', motivo: 'WebSocket do inbox ao vivo (leitura por GET resolve)' },
]

/**
 * Rotas montadas ANTES do middleware de sessão, com autenticação própria (webhooks, links públicos,
 * API pública, sessão e Better Auth). A chave de perfil não chega a elas: troca de senha, troca de e-mail
 * e excluir conta moram em `/api/auth/*` e só aceitam o cookie.
 */
export const API_OUTSIDE_PANEL_PREFIXES: readonly string[] = [
  '/api/webhooks/', '/api/hooks/', '/api/email-public/', '/api/broadcast-public/', '/api/flow-public/',
  '/api/automation-share/', '/api/public/v1/', '/api/pixel.js', '/api/pixel/event', '/api/site-widget/',
  '/api/media/public/', '/api/session/', '/api/invite-preview', '/api/auth/', '/api/dev/workspace', '/api/dev/sign-in', '/api/docs',
]

export const PANEL_ONLY_MESSAGE = 'Esta ação só pode ser feita no painel.'
export const NOT_RELEASED_MESSAGE = 'Esta rota ainda não está liberada para chave.'

/** Caminho no formato do Hono (`:id`, `:nome?`, `/*`) para expressão regular. Casa tanto o caminho real quanto o próprio padrão de outra rota. */
export function routeRegex(path: string) {
  const prefix = path.endsWith('/*')
  const body = (prefix ? path.slice(0, -2) : path).split('/').map(seg =>
    /^:[^/]+\?$/.test(seg) ? '(?:/[^/]+)?' : seg.startsWith(':') ? '/[^/]+' : seg ? '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '').join('')
  return new RegExp(`^${body}${prefix ? '(?:/.*)?' : ''}$`)
}
const compiled = API_KEY_BLOCKED.map(route => ({ ...route, regex: routeRegex(route.path) }))
const sameMethod = (rule: string, method: string) => rule === '*' || rule === method || (rule === 'GET' && method === 'HEAD')

/** Por que a chave não pode usar esta rota (ou `null` se pode). Pedido de upgrade (WebSocket) nunca vai por chave. */
export function apiKeyBlockReason(method: string, path: string, upgrade?: string | null): string | null {
  if (upgrade) return 'WebSocket'
  return compiled.find(route => sameMethod(route.method, method) && route.regex.test(path))?.motivo ?? null
}

/** Rota montada antes do middleware de sessão (não passa pelo acesso por chave). */
export const isOutsidePanel = (path: string) => API_OUTSIDE_PANEL_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix))

/** Lista "MÉTODO /caminho" (ex.: `API_KEY_ALLOWED`) compilada para conferir pedidos. */
export const compileAllowed = (allowed: readonly string[]) => allowed.map(line => {
  const [method, path] = line.split(' ')
  return { method, regex: routeRegex(path) }
})
/** Negado por padrão: a chave só abre rota que está na lista liberada. */
export function apiKeyAllowed(method: string, path: string, allowed: readonly string[] | ReturnType<typeof compileAllowed>): boolean {
  const rules = typeof allowed[0] === 'string' ? compileAllowed(allowed as readonly string[]) : allowed as ReturnType<typeof compileAllowed>
  return rules.some(rule => sameMethod(rule.method, method) && rule.regex.test(path))
}
