import { contactVariableRenderer } from '../db/message-variables'
import { validateFieldValue } from '../db/fields'
import type { FlowAction } from '../schemas/actions'
import { ExternalRequestError, extractPath, isInternalHost, type ExternalErrorCode } from './external-url'

import { fullContactData } from './dynamic-block'
export type ExternalAction = Extract<FlowAction, { type: 'external_request' }>
export type RequestEnv = { DB: D1Database; APP_ENV?: string; DEV_PROVIDER_API_BASE?: string }
export const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 1_000_000
const PREVIEW_CHARS = 2000

export type MappingResult = { path: string; field_id: string; ok: boolean; value?: unknown; error?: string }
export type RequestResult = { status: number | null; duration_ms: number; target: string; error?: { code: ExternalErrorCode; message: string }
  mapped: MappingResult[]; preview?: string }

/** Development journeys call this alias; only a development engine rewrites it to the local fake provider. Loopback itself stays blocked. */
export const DEV_PROVIDER_ALIAS = 'provedor-falso.test'
function developmentAlias(env: RequestEnv, url: URL): URL {
  if (env.APP_ENV !== 'development' || !env.DEV_PROVIDER_API_BASE || url.hostname !== DEV_PROVIDER_ALIAS) return url
  const base = new URL(env.DEV_PROVIDER_API_BASE)
  return new URL(`${url.pathname}${url.search}`, base.origin)
}

/** Log-safe destination: no credentials, no query string. */
function targetOf(url: URL): string { return `${url.host}${url.pathname}`.slice(0, 300) }

/** Rule for every outbound address (also each redirect hop of the site widget diagnosis): http(s), no credentials, never internal. */
export function destination(raw: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new ExternalRequestError('invalid_url', 'O endereço da requisição ficou inválido depois de preencher as variáveis.') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ExternalRequestError('invalid_url', 'Use um endereço http ou https.')
  if (url.username || url.password) throw new ExternalRequestError('invalid_url', 'O endereço não pode conter usuário ou senha.')
  if (isInternalHost(url.hostname)) throw new ExternalRequestError('blocked_address', 'Endereços internos ou de rede local não são permitidos.')
  return url
}

export async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ExternalRequestError('too_large', 'A resposta passou de 1 MB.') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

async function coerce(env: RequestEnv, workspace: string, fieldId: string, value: unknown): Promise<unknown> {
  const field = await env.DB.prepare("SELECT type FROM custom_fields WHERE workspace_id=? AND id=? AND scope='contact'").bind(workspace, fieldId).first<{ type: string }>()
  if (!field) throw new ExternalRequestError('invalid_value', 'O campo do mapeamento não existe mais.')
  let next = value
  if (field.type === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) next = Number(value)
  else if (field.type === 'text' && (typeof value === 'number' || typeof value === 'boolean')) next = String(value)
  else if (field.type === 'boolean' && (value === 'true' || value === 'false')) next = value === 'true'
  try { validateFieldValue(field.type, next) }
  catch { throw new ExternalRequestError('invalid_value', `O valor recebido não combina com o tipo ${field.type} do campo.`) }
  return next
}

/** Performs the request for one contact. Never throws: failures come back in `error` so the flow can go on and the log can show them. */
export async function performExternalRequest(env: RequestEnv, workspace: string, contactId: string, action: ExternalAction): Promise<RequestResult> {
  const started = Date.now()
  const result: RequestResult = { status: null, duration_ms: 0, target: action.url.replace(/^(https?:\/\/[^/?#]*).*$/i, '$1').slice(0, 300), mapped: [] }
  try {
    const plain = await contactVariableRenderer(env.DB, workspace, contactId)
    const asJson = await contactVariableRenderer(env.DB, workspace, contactId, value => JSON.stringify(value).slice(1, -1))
    const asUrl = await contactVariableRenderer(env.DB, workspace, contactId, encodeURIComponent)
    // Variables sit after the host (checked at publish), so rendering never changes the destination.
    const url = destination(asUrl(action.url))
    result.target = targetOf(url)
    const destinationUrl = developmentAlias(env, url)
    const headers = new Headers()
    try { for (const header of action.headers) headers.set(header.name, plain(header.value)) }
    catch { throw new ExternalRequestError('invalid_url', 'Um cabeçalho ficou com caracteres inválidos depois de preencher as variáveis.') }
    const hasBody = action.method !== 'GET' && action.body !== undefined && action.body !== ''
    if (hasBody && !headers.has('content-type')) headers.set('content-type', 'application/json')
    const contentType = headers.get('content-type') ?? ''
    // {{full_contact_data}} vira o JSON completo do contato (o mesmo do bloco dinâmico), inserido depois das outras variáveis.
    const FULL = '\u0000full_contact_data\u0000'
    const raw = action.body?.replaceAll('{{full_contact_data}}', FULL)
    let body = hasBody ? (/json/i.test(contentType) ? asJson(raw!) : plain(raw!)) : undefined
    if (body?.includes(FULL)) body = body.replaceAll(FULL, JSON.stringify(await fullContactData(env.DB, workspace, contactId)))
    let response: Response
    try {
      response = await fetch(destinationUrl, { method: action.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      throw new ExternalRequestError(timedOut ? 'timeout' : 'network', timedOut ? 'A requisição passou do limite de 10 segundos.' : 'Não foi possível conectar ao endereço.')
    }
    result.status = response.status
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new ExternalRequestError('redirect', 'A resposta pediu redirecionamento, que não é seguido.') }
    const text = await readLimited(response)
    result.preview = text.slice(0, PREVIEW_CHARS)
    if (response.status !== 200) throw new ExternalRequestError('http_status', `O servidor respondeu ${response.status}; só a resposta 200 grava campos.`)
    if (!action.mappings.length) return result
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new ExternalRequestError('invalid_json', 'A resposta não é um JSON válido, então nenhum campo foi gravado.') }
    for (const mapping of action.mappings) {
      const found = extractPath(parsed, mapping.path)
      if (found === undefined || found === null) {
        result.mapped.push({ path: mapping.path, field_id: mapping.field_id, ok: false, error: 'Caminho não encontrado na resposta.' })
        continue
      }
      try { result.mapped.push({ path: mapping.path, field_id: mapping.field_id, ok: true, value: await coerce(env, workspace, mapping.field_id, found) }) }
      catch (error) { result.mapped.push({ path: mapping.path, field_id: mapping.field_id, ok: false, error: error instanceof Error ? error.message : 'Valor inválido.' }) }
    }
  } catch (error) {
    result.error = error instanceof ExternalRequestError ? { code: error.code, message: error.message } : { code: 'network', message: 'Falha inesperada na requisição.' }
  } finally {
    result.duration_ms = Date.now() - started
  }
  if (!result.error) {
    const failed = result.mapped.find(item => !item.ok)
    if (failed) result.error = { code: failed.error?.startsWith('Caminho') ? 'path_not_found' : 'invalid_value', message: `${failed.path}: ${failed.error}` }
  }
  return result
}

export function logStatement(env: RequestEnv, entry: { id: string; workspace_id: string; automation_id?: string | null; node_id?: string | null; run_id?: string | null
  contact_id: string; source: 'run' | 'test'; method: string }, result: RequestResult, guard?: { sql: string; bind: unknown[] }): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO external_request_logs (id,workspace_id,automation_id,node_id,run_id,contact_id,source,method,target,status,outcome,error_code,message,duration_ms)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard ? guard.sql : '1'} ON CONFLICT(id) DO NOTHING`)
    .bind(entry.id, entry.workspace_id, entry.automation_id ?? null, entry.node_id ?? null, entry.run_id ?? null, entry.contact_id, entry.source, entry.method,
      result.target, result.status, result.error ? 'error' : 'ok', result.error?.code ?? null, result.error?.message ?? null, result.duration_ms, ...(guard?.bind ?? []))
}
