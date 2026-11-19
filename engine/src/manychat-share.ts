import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { maskHash, type SharedConversion } from './flow/manychat-import'
import { connectionColumns, connectionFromRow, type ConnectionRow } from './channels/core/connection'
import { saveCommentTrigger } from './db/comment-triggers'
import { saveKeywordRule, type KeywordRuleInput } from './db/keywords'

/** Limites da busca: o JSON é de terceiros, então tempo e tamanho são contidos. */
export const SHARE_TIMEOUT_MS = 15_000
export const SHARE_MAX_BYTES = 5_000_000
const SHARE_ENDPOINT = 'https://app.manychat.com/manychat/getSharedFlow'
/** Só em desenvolvimento com provedor falso: hash de teste servido por DEV_PROVIDER_API_BASE (jornadas e2e). */
export const DEV_HASH = /^e2e_[a-z0-9_-]{1,40}$/
export const devHashAllowed = (env: Env) => env.APP_ENV === 'development' && !!env.DEV_PROVIDER_API_BASE

class TooBig extends Error {}
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > SHARE_MAX_BYTES) throw new TooBig()
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > SHARE_MAX_BYTES) { await reader.cancel(); throw new TooBig() }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength }
  return new TextDecoder().decode(out)
}

const down = 'A ManyChat não respondeu agora. Tente de novo em alguns minutos.'

/** GET público `getSharedFlow` (sem login). Erros viram mensagens em pt-BR para quem colou o link; o hash nunca vai inteiro para o log. */
export async function fetchSharedFlow(env: Env, hash: string): Promise<Record<string, unknown>> {
  const base = DEV_HASH.test(hash) && devHashAllowed(env) ? `${env.DEV_PROVIDER_API_BASE!.replace(/\/$/, '')}/manychat/getSharedFlow` : SHARE_ENDPOINT
  let response: Response
  try {
    response = await fetch(`${base}?share_hash=${encodeURIComponent(hash)}`, { redirect: 'manual', signal: AbortSignal.timeout(SHARE_TIMEOUT_MS), headers: { accept: 'application/json' } })
  } catch (error) {
    console.warn('manychat_share_fetch_failed', { hash: maskHash(hash), reason: error instanceof Error ? error.name : 'erro' })
    throw new HTTPException(502, { message: down })
  }
  if (response.status === 404) { await response.body?.cancel(); throw new HTTPException(404, { message: 'Fluxo não encontrado na ManyChat: o link pode ter sido desativado ou estar incompleto.' }) }
  if (response.status !== 200) {
    await response.body?.cancel()
    console.warn('manychat_share_http', { hash: maskHash(hash), status: response.status })
    throw new HTTPException(502, { message: down })
  }
  let text: string
  try { text = await readBounded(response) } catch (error) {
    if (error instanceof TooBig) throw new HTTPException(413, { message: 'O fluxo compartilhado é grande demais para importar por aqui.' })
    throw new HTTPException(502, { message: down })
  }
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new HTTPException(502, { message: 'A ManyChat devolveu uma resposta que não deu para ler. Tente de novo.' }) }
  const data = json as Record<string, unknown> | null
  if (!data || typeof data !== 'object' || data.state === false || !data.flow || typeof data.flow !== 'object') {
    throw new HTTPException(404, { message: 'Fluxo não encontrado ou não compartilhado na ManyChat. Confira se o link está certo e se o compartilhamento continua ligado.' })
  }
  return data
}

export type TriggerOutcome = { kind: string; name: string; status: 'created' | 'skipped'; id?: string; reason?: string; notes?: string[] }
type Ctx = Context<{ Bindings: Env; Variables: AuthVariables }>
const msg = (error: unknown) => (error instanceof Error && error.message ? error.message : 'erro desconhecido')

/** Recria os gatilhos que têm equivalente, sempre desligados (a automação nasce em rascunho); o resto volta com o motivo. */
export async function createTriggers(c: Ctx, automationId: string, converted: SharedConversion): Promise<TriggerOutcome[]> {
  const db = c.env.DB, workspace = c.var.principal.workspaceId
  const out: TriggerOutcome[] = []
  let igRows: ConnectionRow[] | null = null
  const commentConnection = async () => {
    igRows ??= (await db.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND archived_at IS NULL ORDER BY id`).bind(workspace).all<ConnectionRow>()).results
    return igRows.map(connectionFromRow).find(cn => cn.status === 'connected' && cn.profile.inbound.comment && cn.profile.comments?.privateReply)
  }
  for (const t of converted.triggers) {
    if (t.kind === 'other') {
      out.push({ kind: t.label, name: t.name, status: 'skipped', reason: `Gatilho do tipo “${t.label}” não tem equivalente automático; crie o gatilho no painel.` })
      continue
    }
    if (t.kind === 'comment') {
      const connection = await commentConnection()
      if (!connection) { out.push({ kind: 'comment', name: t.name, status: 'skipped', reason: 'Nenhuma conta conectada recebe comentários; conecte a conta e crie o gatilho de comentário no painel.' }); continue }
      const notes: string[] = []
      if (!t.all_posts) notes.push('Na ManyChat o gatilho valia para uma publicação específica; aqui ficou para todas. Escolha a publicação antes de ligar.')
      if (t.include.length > 10 || t.exclude.length > 10) notes.push('Mais de 10 palavras: só as 10 primeiras entraram.')
      const replies = t.public_replies.map(r => r.slice(0, 140)).slice(0, 8)
      if (replies.length < t.public_replies.length || t.public_replies.some(r => r.length > 140)) notes.push('Respostas públicas acima do limite (8, até 140 letras) foram cortadas.')
      try {
        const made = await saveCommentTrigger(db, workspace, automationId, { type: 'ig_comment', name: t.name.slice(0, 100), connection_id: connection.id, node_id: 'trigger', enabled: false,
          config: { target: 'all', include: t.any_comment ? [] : t.include.slice(0, 10).map(w => w.slice(0, 500)), exclude: t.exclude.slice(0, 10).map(w => w.slice(0, 500)), public_replies: replies } })
        out.push({ kind: 'comment', name: t.name, status: 'created', id: made.id, notes })
      } catch (error) { out.push({ kind: 'comment', name: t.name, status: 'skipped', reason: `Gatilho de comentário não criado: ${msg(error)}` }) }
      continue
    }
    const channel = (t.channel ?? converted.channel) as KeywordRuleInput['channel'] | null
    if (!channel) { out.push({ kind: 'keyword', name: t.name, status: 'skipped', reason: 'Não deu para saber o canal da palavra-chave; crie-a no painel.' }); continue }
    const notes = [...(t.guessed ? ['Uma regra da palavra-chave não foi reconhecida; ficou “contém”. Confira.'] : []), ...(t.dropped ? [`Só as 2 primeiras regras entraram (${t.dropped} ficaram de fora).`] : []),
      ...(t.rules.some(r => r.words.length > 10) ? ['Mais de 10 palavras numa regra: só as 10 primeiras entraram.'] : [])]
    try {
      const made = await saveKeywordRule(db, workspace, { name: t.name.slice(0, 200), channel, automation_id: automationId, active: false, rules: t.rules.map(r => ({ condition: r.condition, words: r.words.slice(0, 10).map(w => w.slice(0, 500)) })) })
      out.push({ kind: 'keyword', name: t.name, status: 'created', id: made.id, notes })
    } catch (error) { out.push({ kind: 'keyword', name: t.name, status: 'skipped', reason: `Palavra-chave não criada: ${msg(error)}` }) }
  }
  return out
}
