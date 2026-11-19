import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { seed, graph } from './fixtures'
import { actions } from '../src/flow/nodes'
import { encryptCredentials } from '../src/channels/core/crypto'
import { runSheets, sheetsToken } from '../src/google-sheets'
import type { FlowEnv, Run } from '../src/flow/types'

const bindings = env as unknown as FlowEnv
const run = { id: 'gs-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', automation_id: 'auto-a' } as Run
let pem = ''
const sheet = [['email', 'plano'], ['ana@x.test', 'Ouro'], ['bia@x.test', 'Prata']]
const calls: { url: string; method: string; body?: string }[] = []

beforeEach(async () => {
  await seed()
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer)
  pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`
  calls.length = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input), method = init?.method ?? 'GET'
    calls.push({ url, method, ...(init?.body ? { body: String(init.body) } : {}) })
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'tok' })
    if (method === 'GET') return Response.json({ values: sheet })
    return Response.json({})
  })
  const sealed = await encryptCredentials(bindings as never, { workspaceId: 'a', connectionId: 'integration:google_sheets' }, { client_email: 'bot@proj.iam.gserviceaccount.com', private_key: pem })
  await env.DB.batch([
    env.DB.prepare("INSERT INTO workspace_integrations (workspace_id,kind,label,ciphertext,iv,key_version) VALUES ('a','google_sheets','bot@proj.iam.gserviceaccount.com',?,?,?)").bind(sealed.ciphertext, sealed.iv, sealed.keyVersion),
    env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('gs-v','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    env.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,channel_id,automation_version_id) VALUES ('gs-run','a','c-a','ch-a','gs-v')"),
  ])
})
afterEach(() => vi.restoreAllMocks())

it('o token sai de um JWT RS256 assinado com a chave da conta de serviço', async () => {
  expect(await sheetsToken({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: pem })).toBe('tok')
  const assertion = new URLSearchParams(calls[0].body).get('assertion')!
  expect(JSON.parse(atob(assertion.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))).toMatchObject({ iss: 'bot@proj.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/spreadsheets' })
})

it('ação insere linha com variáveis, busca linha para campos e atualiza a célula da linha encontrada', async () => {
  await actions(bindings, run, { actions: [{ type: 'google_sheets', sheets: { operation: 'insert_row', spreadsheet_id: 'planilha-123456', sheet: 'Leads', values: ['{{primeiro_nome|}}', 'novo'] } }] }, 1)
  const append = calls.find(c => c.url.includes(':append'))!
  expect(JSON.parse(append.body!)).toEqual({ values: [['Mariana', 'novo']] })
  await actions(bindings, run, { actions: [{ type: 'google_sheets', sheets: { operation: 'get_row', spreadsheet_id: 'planilha-123456', sheet: 'Leads', lookup_column: 'A', lookup_value: 'bia@x.test', mappings: [{ column: 'B', field_id: 'field-a' }] } }] }, 2)
  expect(await env.DB.prepare("SELECT value FROM contact_field_values WHERE contact_id='c-a' AND field_id='field-a'").first('value')).toBe('"Prata"')
  const result = await runSheets({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: pem }, { operation: 'update_row', spreadsheet_id: 'planilha-123456', sheet: 'Leads', lookup_column: 'A', lookup_value: 'ana@x.test', values: [{ column: 'B', value: 'Diamante' }] })
  expect(result).toEqual({ found: {} })
  expect(decodeURIComponent(calls.at(-1)!.url)).toContain("'Leads'!B2")
})

it('falha da planilha não derruba o passo e vai para Registros', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).includes('oauth2') ? Response.json({ access_token: 'tok' }) : new Response('{}', { status: 403 }))
  await actions(bindings, run, { actions: [{ type: 'google_sheets', sheets: { operation: 'insert_row', spreadsheet_id: 'planilha-123456', sheet: 'Leads', values: ['x'] } }] }, 3)
  expect(await env.DB.prepare("SELECT error_code,message FROM external_request_logs").first()).toMatchObject({ error_code: 'google_sheets', message: expect.stringContaining('Compartilhe') })
})

it('exporta os contatos para a planilha com cabeçalho e etiquetas', async () => {
  const { exportContactsToSheet, sheetsAccount } = await import('../src/google-sheets')
  const acc = (await sheetsAccount(bindings, 'a'))!
  const n = await exportContactsToSheet(env.DB, 'a', acc, { spreadsheet_id: 'planilha-123456', sheet: 'Contatos' })
  expect(n).toBeGreaterThan(0)
  const append = calls.find(c => c.url.includes(':append'))!
  const values = JSON.parse(append.body!).values as string[][]
  expect(values[0]).toEqual(['id', 'nome', 'sobrenome', 'email', 'telefone', 'situação', 'inscrito em', 'etiquetas'])
  expect(values).toHaveLength(n + 1)
})
