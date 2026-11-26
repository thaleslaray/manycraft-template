// Contrato das respostas descritas no catálogo (campo `resposta`): o formato do documento não pode mentir.
// Cada rota com `resposta` é chamada de verdade com dados semeados, e o corpo real tem de passar no schema declarado.
// Rota nova com `resposta`: acrescente a chamada em `chamadas` (com o que precisa vir cheio) ou o motivo em `semChamada`.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AREAS } from '../src/api-docs/catalogo'
import type { EntradaCatalogo } from '../src/api-docs/tipos'
import { ensureConversation, recordMessage } from '../src/inbox/service'
import { saveSequence } from '../src/db/sequences'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { giveCredentials } from './credentials'
import { graph } from './fixtures'

type Chamada = {
  /** Caminho depois de `/api/` (com os ids do que foi semeado). */
  url: () => string
  corpo?: () => unknown
  /** Listas que precisam vir com ao menos um item, senão o schema dos itens não é exercitado. */
  cheio?: (corpo: any) => unknown[][]
}

/** Rotas com `resposta` que o teste não consegue chamar, com o motivo. Hoje nenhuma. */
const semChamada: Record<string, string> = {}

let conversa = '', sequencia = '', transmissao = ''
const filtroComTag = { match: 'all', rules: [{ type: 'tag', tag_id: 'tag-a', operator: 'has' }] }

const chamadas: Record<string, Chamada> = {
  'GET /api/contacts': { url: () => 'contacts', cheio: b => [b.rows, b.rows[0].tags] },
  'POST /api/contacts': { url: () => 'contacts', corpo: () => ({ first_name: 'Ana', last_name: 'Souza', email: 'ana@exemplo.com', phone: '+55 11 91234-5678' }) },
  'GET /api/contacts/:id': { url: () => 'contacts/c-a', cheio: b => [b.channels, b.tags, b.field_values] },
  'POST /api/contacts/:id/tags': { url: () => 'contacts/c-a/tags', corpo: () => ({ tag_id: 'tag-a', op: 'remove' }) },
  'POST /api/contacts/query': { url: () => 'contacts/query', corpo: () => ({ filter: filtroComTag }), cheio: b => [b.rows] },
  'GET /api/tags': { url: () => 'tags', cheio: b => [b] },
  'POST /api/tags': { url: () => 'tags', corpo: () => ({ name: 'Cliente' }) },
  'GET /api/fields': { url: () => 'fields', cheio: b => [b] },
  'POST /api/fields': { url: () => 'fields', corpo: () => ({ name: 'Plano', type: 'text' }) },
  'GET /api/segments': { url: () => 'segments', cheio: b => [b] },
  'POST /api/segments': { url: () => 'segments', corpo: () => ({ name: 'Clientes', filter: filtroComTag }) },
  'GET /api/segments/:id': { url: () => 'segments/seg-a' },
  'GET /api/sequences': { url: () => 'sequences', cheio: b => [b, b[0].steps] },
  'POST /api/sequences': { url: () => 'sequences', corpo: () => ({ name: 'Boas-vindas 2', steps: [{ id: 'passo-2', delay_seconds: 3600, sending_time_settings: { type: 'timelimit', from: '09:00', to: '18:00', weekdays: [1, 2, 3] }, status: 'draft', automation_id: null }] }) },
  'GET /api/sequences/:id': { url: () => `sequences/${sequencia}`, cheio: b => [b.steps] },
  'GET /api/inbox/conversations': { url: () => 'inbox/conversations?status=all', cheio: b => [b.rows, b.rows[0].labels] },
  'GET /api/inbox/conversations/:id/messages': { url: () => `inbox/conversations/${conversa}/messages`, cheio: b => [b.rows] },
  'POST /api/inbox/conversations/:id/labels': { url: () => `inbox/conversations/${conversa}/labels`, corpo: () => ({ label_id: 'etq-a', on: true }), cheio: b => [b.labels] },
  'GET /api/inbox/labels': { url: () => 'inbox/labels', cheio: b => [b] },
  'POST /api/inbox/labels': { url: () => 'inbox/labels', corpo: () => ({ name: 'Urgente', color: 'danger' }) },
  'GET /api/automations': { url: () => 'automations', cheio: b => [b] },
  'GET /api/automations/:id': { url: () => 'automations/auto-a', cheio: b => [b.triggers, b.published_version ? [b.published_version] : []] },
  'GET /api/folders': { url: () => 'folders', cheio: b => [b.folders] },
  'GET /api/broadcasts': { url: () => 'broadcasts', cheio: b => [b] },
  'GET /api/broadcasts/:id': { url: () => `broadcasts/${transmissao}` },
  'GET /api/broadcasts/audience': { url: () => 'broadcasts/audience?channel=telegram&channel_id=ch-a' },
  'GET /api/connections': { url: () => 'connections', cheio: b => [b] },
  'GET /api/connections/:id': { url: () => 'connections/ch-a' },
  'GET /api/keywords': { url: () => 'keywords', cheio: b => [b, b[0].rules] },
  'GET /api/team': { url: () => 'team', cheio: b => [b] },
  'GET /api/dashboard': { url: () => 'dashboard', cheio: b => [b.metrics, b.checklist, b.channels] },
  'GET /api/insights': { url: () => 'insights', cheio: b => [b.points] },
}

const descritas: EntradaCatalogo[] = AREAS.flatMap(area => area.entradas).filter(e => e.resposta)
const rota = (e: EntradaCatalogo) => `${e.metodo} ${e.caminho}`

beforeEach(async () => {
  await seedAuth()
  // Telegram com credencial: a conexão de teste lê o perfil e entra no público das transmissões.
  await env.DB.prepare("UPDATE channels SET type='telegram' WHERE id='ch-a'").run()
  await giveCredentials(env, 'ch-a', { botToken: 'TESTONLY', webhookSecret: 'contrato-a' })
  conversa = await ensureConversation(env, 'a', 'c-a', 'ch-a')
  await recordMessage(env, { id: crypto.randomUUID(), workspaceId: 'a', conversationId: conversa, direction: 'in', sender: 'contact', text: 'Quero saber o preço' })
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automation_versions(workspace_id,id,automation_id,version,graph) VALUES ('a','versao-a','auto-a',1,?)").bind(JSON.stringify(graph)),
    env.DB.prepare("UPDATE automations SET published_version_id='versao-a',status='live' WHERE workspace_id='a' AND id='auto-a'"),
    env.DB.prepare("INSERT INTO folders(id,workspace_id,name) VALUES ('pasta-a','a','Lançamento')"),
    env.DB.prepare("INSERT INTO inbox_labels(id,workspace_id,name,color) VALUES ('etq-a','a','VIP','accent')"),
    env.DB.prepare('INSERT INTO conversation_labels(conversation_id,label_id) VALUES (?,?)').bind(conversa, 'etq-a'),
    env.DB.prepare("INSERT INTO segments(id,workspace_id,name,filter) VALUES ('seg-a','a','Com a etiqueta',?)").bind(JSON.stringify(filtroComTag)),
  ])
  sequencia = (await saveSequence(env.DB, 'a', { name: 'Boas-vindas', steps: [{ id: 'passo-1', delay_seconds: 86400, sending_time_settings: { type: 'all' }, status: 'draft', automation_id: null }] })).id
  const criada = await authenticatedRequest('broadcasts', 'a', { method: 'POST', body: JSON.stringify({ name: 'Oferta', content: 'Oi! A oferta começou.', status: 'draft', audience: { tag: 'all', channel: 'telegram', channel_id: 'ch-a' } }) })
  expect(criada.status, await criada.clone().text()).toBe(201)
  transmissao = (await criada.json() as { id: string }).id
})

describe('formato das respostas descritas no catálogo', () => {
  it('toda rota com `resposta` tem chamada neste teste ou motivo para ficar de fora', () => {
    expect(descritas.length).toBeGreaterThanOrEqual(30)
    const semCobertura = descritas.map(rota).filter(r => !chamadas[r] && !semChamada[r])
    expect(semCobertura).toEqual([])
    const sobrando = Object.keys(chamadas).filter(r => !descritas.some(e => rota(e) === r))
    expect(sobrando).toEqual([])
  })

  it.each(descritas.filter(e => chamadas[rota(e)]).map(e => [rota(e), e] as const))('%s devolve o formato declarado', async (nome, entrada) => {
    const chamada = chamadas[nome]!
    const corpo = chamada.corpo?.()
    const resposta = await authenticatedRequest(chamada.url(), 'a', { method: entrada.metodo, ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }) })
    const texto = await resposta.text()
    expect([200, 201], texto.slice(0, 500)).toContain(resposta.status)
    const json = JSON.parse(texto) as unknown
    const conferido = entrada.resposta!.safeParse(json)
    expect(conferido.success, conferido.success ? '' : `${z.prettifyError(conferido.error)}\n${texto.slice(0, 1500)}`).toBe(true)
    for (const [i, lista] of (chamada.cheio?.(json) ?? []).entries()) expect(lista.length, `lista ${i} veio vazia: o schema dos itens não foi exercitado`).toBeGreaterThan(0)
  })
})
