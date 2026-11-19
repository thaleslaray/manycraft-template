import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { seed } from './fixtures'
import { publishAutomation } from '../src/db/automations'
import { deleteKeywordRule, getKeywordRule, listKeywordRules, moveKeywordRule, saveKeywordRule, setKeywordRuleActive,
  type KeywordRuleInput } from '../src/db/keywords'
import { consumeInbound } from '../src/jobs'
import type { IntegrationEnv } from '../src/integrations'

const input = (overrides: Partial<KeywordRuleInput> = {}): KeywordRuleInput => ({
  name: 'Entrega do material', channel: 'telegram', automation_id: 'auto-a', active: true,
  rules: [{ condition: 'contains', words: ['material'] }], ...overrides,
})
let serial = 0
let runtime: IntegrationEnv
let create: ReturnType<typeof vi.fn>

beforeEach(async () => {
  await seed()
  serial = 0
  await env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','test-bot')").run()
  await publishAutomation(env.DB, 'a', 'auto-a')
  create = vi.fn(async () => ({ id: 'test-workflow' }))
  runtime = { ...env, FLOW_RUN: { create }, INBOX_HUB: undefined } as unknown as IntegrationEnv
  // Dispatch tests stop at the existing Workflow boundary; no external channel is called.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External fetch is forbidden in this test'))
})
afterEach(() => { vi.restoreAllMocks() })

async function inbound(text: string) {
  const update = ++serial
  let acknowledged = false
  let retried = false
  await consumeInbound({ queue: 'test', messages: [{ id: String(update), attempts: 1, timestamp: new Date(),
    body: { version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'tg-a', eventId: String(update), receivedAt: Date.now(),
      payload: { update_id: update, message: { message_id: update, date: Math.floor(Date.now() / 1000),
        from: { id: 100, first_name: 'Pessoa fictícia' }, chat: { id: 100, type: 'private' }, text } } },
    ack() { acknowledged = true }, retry() { retried = true },
  }], ackAll() {}, retryAll() {} } as unknown as MessageBatch<unknown>, runtime)
  expect({ acknowledged, retried }).toEqual({ acknowledged: true, retried: false })
}

it('CRUD persiste nomes, canal, composição, ativo e exclusão nos registros usados pelo motor', async () => {
  const value = input({ name: 'Nome longo de regra que continua legível e pode ser salvo normalmente', rules: [
    { condition: 'contains', words: ['  material  ', 'guia'] }, { condition: 'not_contains', words: ['cancelar'] },
  ] })
  const created = await saveKeywordRule(env.DB, 'a', value)
  expect(created).toMatchObject({ name: value.name, channel: 'telegram', active: true,
    rules: [{ condition: 'contains', words: ['material', 'guia'] }, { condition: 'not_contains', words: ['cancelar'] }] })
  expect(await getKeywordRule(env.DB, 'a', created.id)).toEqual(created)
  expect(await env.DB.prepare('SELECT rule,status FROM keywords WHERE workspace_id=? AND id=?')
    .bind('a', created.id).first()).toEqual({ rule: 'group', status: 'live' })
  await inbound('quero o material')
  await inbound('cancelar o material')
  expect(create).toHaveBeenCalledTimes(1)
  await setKeywordRuleActive(env.DB, 'a', created.id, false)
  await inbound('quero o material novamente')
  expect(create).toHaveBeenCalledTimes(1)
  const updated = await saveKeywordRule(env.DB, 'a', input({ name: 'Alterada', rules: [{ condition: 'equals', words: ['novo'] }] }), created.id)
  expect(updated.rules).toEqual([{ condition: 'equals', words: ['novo'] }])
  expect(await env.DB.prepare('SELECT count(*) AS n FROM keywords WHERE workspace_id=? AND parent_id=?')
    .bind('a', created.id).first('n')).toBe(0)
  await inbound('novo')
  expect(create).toHaveBeenCalledTimes(2)
  await deleteKeywordRule(env.DB, 'a', created.id)
  expect(await getKeywordRule(env.DB, 'a', created.id)).toBeNull()
  await inbound('novo')
  expect(create).toHaveBeenCalledTimes(2)
})

it.each([
  ['equals', ['preco'], 'PREÇO', 'quero preço'],
  ['contains', ['café'], 'quero CAFE agora', 'material'],
  ['word', ['acao'], 'uma AÇÃO!', 'reação'],
  ['starts', ['promoção'], 'PROMOCAO nova', 'a promoção'],
  ['not_contains', ['não', 'cancelar'], 'material liberado', 'quero NAO'],
] as const)('a condição %s salva pelo painel controla o consumer real', async (condition, words, hit, miss) => {
  await saveKeywordRule(env.DB, 'a', input({ rules: [{ condition, words: [...words] }] }))
  await inbound(hit)
  await inbound(miss)
  expect(create).toHaveBeenCalledTimes(1)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM flow_runs WHERE workspace_id='a'").first('n')).toBe(1)
  expect(fetch).not.toHaveBeenCalled()
})

it('vale a regra mais acima na lista; ao reordenar, o disparo muda no próximo recebimento', async () => {
  const first = await saveKeywordRule(env.DB, 'a', input({ name: 'Primeira' }))
  const second = await saveKeywordRule(env.DB, 'a', input({ name: 'Segunda' }))
  // A data de criação só desempata prioridades iguais; aqui a Segunda é a mais antiga e mesmo assim perde.
  await env.DB.prepare('UPDATE triggers SET created_at=? WHERE id=(SELECT trigger_id FROM keywords WHERE id=?)').bind(200, first.id).run()
  await env.DB.prepare('UPDATE triggers SET created_at=? WHERE id=(SELECT trigger_id FROM keywords WHERE id=?)').bind(100, second.id).run()
  await inbound('material')
  const fired = async () => (await env.DB.prepare(`SELECT k.id FROM flow_runs r JOIN keywords k
    ON k.workspace_id=r.workspace_id AND k.trigger_id=r.trigger_id WHERE r.workspace_id='a' ORDER BY r.created_at`).all()).results.map(row => row.id)
  expect(await fired()).toEqual([first.id])
  expect((await moveKeywordRule(env.DB, 'a', second.id, 0))[0]!.id).toBe(second.id)
  expect((await listKeywordRules(env.DB, 'a'))[0]!.id).toBe(second.id)
  await inbound('material')
  expect(await fired()).toEqual([first.id, second.id])
  expect(await env.DB.prepare("SELECT priority FROM keywords WHERE workspace_id='b' AND id='key-b'").first('priority')).toBe(1)
})

it('duas regras que casam: vale a de cima da lista, mesmo que a outra seja mais específica', async () => {
  const broad = await saveKeywordRule(env.DB, 'a', input({ name: 'Abrangente' }))
  const exact = await saveKeywordRule(env.DB, 'a', input({ name: 'Específico', rules: [{ condition: 'equals', words: ['material'] }] }))
  await inbound('material')
  await moveKeywordRule(env.DB, 'a', exact.id, 0)
  await inbound('material')
  await inbound('quero o material')
  const rows = await env.DB.prepare(`SELECT k.id FROM flow_runs r JOIN keywords k
    ON k.workspace_id=r.workspace_id AND k.trigger_id=r.trigger_id WHERE r.workspace_id='a' ORDER BY r.created_at`).all()
  expect(rows.results.map(row => row.id)).toEqual([broad.id, exact.id, broad.id])
  expect(create).toHaveBeenCalledTimes(3)
  expect(fetch).not.toHaveBeenCalled()
})

it('a regra Curtir salva pelo painel sem palavras e dispara só com o polegar', async () => {
  const created = await saveKeywordRule(env.DB, 'a', input({ name: 'Curtiu', rules: [{ condition: 'thumbs_up', words: ['ignorada'] }] }))
  expect(created.rules).toEqual([{ condition: 'thumbs_up', words: [] }])
  expect(await env.DB.prepare('SELECT rule,words FROM keywords WHERE id=?').bind(created.id).first()).toEqual({ rule: 'thumbs_up', words: '[]' })
  await inbound('👍🏽')
  await inbound('👍 valeu')
  await inbound('material')
  expect(create).toHaveBeenCalledTimes(1)
  // As demais condições continuam exigindo palavra.
  await expect(saveKeywordRule(env.DB, 'a', input({ rules: [{ condition: 'contains', words: [] }] }))).rejects.toThrow()
})

it('isola leitura, escrita, canal, automação, prioridade e exclusão por workspace', async () => {
  expect(await getKeywordRule(env.DB, 'a', 'key-b')).toBeNull()
  expect((await listKeywordRules(env.DB, 'a')).some(row => row.id === 'key-b')).toBe(false)
  await expect(saveKeywordRule(env.DB, 'a', input(), 'key-b')).rejects.toMatchObject({ status: 404 })
  await expect(saveKeywordRule(env.DB, 'a', input({ automation_id: 'auto-b' }))).rejects.toMatchObject({ status: 404 })
  await expect(setKeywordRuleActive(env.DB, 'a', 'key-b', true)).rejects.toMatchObject({ status: 404 })
  await expect(moveKeywordRule(env.DB, 'a', 'key-b', 0)).rejects.toMatchObject({ status: 404 })
  await expect(deleteKeywordRule(env.DB, 'a', 'key-b')).rejects.toMatchObject({ status: 404 })
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES('tt-b','b','tiktok','foreign')").run()
  await expect(saveKeywordRule(env.DB, 'a', input({ channel: 'tiktok' }))).rejects.toMatchObject({ status: 400 })
  expect(await getKeywordRule(env.DB, 'b', 'key-b')).toMatchObject({ active: false, priority: 1, rules: [{ condition: 'contains', words: ['quero'] }] })
})

it.each([
  { name: '  ' }, { channel: 'invalid' }, { active: 'true' }, { rules: [] },
  { rules: [{ condition: 'contains', words: ['  '] }] },
  { rules: [{ condition: 'any', words: ['a'] }] },
  { rules: [{ condition: 'contains', words: Array.from({ length: 11 }, () => 'a') }] },
  { workspace_id: 'b' }, { priority: -1 },
])('Zod rejeita dados inválidos sem gravar (%j)', async invalid => {
  await expect(saveKeywordRule(env.DB, 'a', { ...input(), ...invalid } as KeywordRuleInput)).rejects.toThrow()
  expect((await listKeywordRules(env.DB, 'a')).map(row => row.id)).toEqual(['key-a'])
})

it('recusa automação sem publicação e índices de prioridade inválidos', async () => {
  await env.DB.prepare("INSERT INTO automations(id,workspace_id,name) VALUES('draft-only','a','Rascunho')").run()
  await expect(saveKeywordRule(env.DB, 'a', input({ automation_id: 'draft-only' }))).rejects.toMatchObject({ status: 404 })
  await expect(moveKeywordRule(env.DB, 'a', 'key-a', 10)).rejects.toMatchObject({ status: 400 })
  await expect(moveKeywordRule(env.DB, 'a', 'key-a', -1)).rejects.toThrow()
})

it('alterar ou desativar uma regra não reconfigura regras irmãs de um gatilho legado', async () => {
  await env.DB.prepare("INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES('sibling','a','trg-a','contains','[\"legado\"]','live',2)").run()
  await setKeywordRuleActive(env.DB, 'a', 'key-a', false)
  expect(await env.DB.prepare("SELECT status FROM triggers WHERE id='trg-a'").first('status')).toBe('active')
  await saveKeywordRule(env.DB, 'a', input({ name: 'Independente' }), 'key-a')
  expect(await env.DB.prepare("SELECT trigger_id FROM keywords WHERE id='key-a'").first('trigger_id')).not.toBe('trg-a')
  expect(await getKeywordRule(env.DB, 'a', 'sibling')).toMatchObject({ name: 'Palavra a', channel: 'instagram', active: true })
})

it('escolhe uma conexão com entrada permitida e preserva a conexão explícita da regra de DM', async () => {
  await env.DB.prepare("UPDATE channels SET status='connected' WHERE id='tg-a'").run()
  await env.DB.prepare(`INSERT INTO channels(id,workspace_id,type,external_id,status,capabilities_override)
    VALUES('tg-0','a','telegram','blocked-bot','connected','{"inbound":{"message":false}}')`).run()
  const saved = await saveKeywordRule(env.DB, 'a', input())
  expect(saved.connection_id).toBe('tg-a')
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id,status) VALUES('tg-z','a','telegram','other-bot','connected')").run()
  const explicit = await saveKeywordRule(env.DB, 'a', input({ connection_id: 'tg-z' }))
  expect(explicit.connection_id).toBe('tg-z')
  await expect(saveKeywordRule(env.DB, 'a', input({ connection_id: 'tg-0' }))).rejects.toMatchObject({ status: 400 })
  await expect(saveKeywordRule(env.DB, 'a', input({ connection_id: 'ig-b' }))).rejects.toMatchObject({ status: 404 })
})
