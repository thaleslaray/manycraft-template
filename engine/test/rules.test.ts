import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

const request = (path: string, method = 'GET', body?: unknown) => authenticatedRequest(path, 'a', {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const config = (extra = {}) => ({ name: 'Lead para nutrição', trigger: { type: 'tag_added' }, event_filter: { tag_id: 'lead' },
  actions: [{ type: 'add_to_sequence', sequence_id: 'nurture' }], frequency: 'always', ...extra })
async function create(input = config()) {
  const response = await request('rules', 'POST', input)
  expect(response.status).toBe(201)
  return response.json() as Promise<any>
}
async function publish(input = config()) {
  const rule = await create(input)
  expect((await request(`rules/${rule.id}/publish`, 'POST')).status).toBe(200)
  return rule.id as string
}
beforeEach(async () => {
  await seedAuth()
  await env.DB.prepare("INSERT INTO tags(id,workspace_id,name) VALUES('lead','a','Lead'),('result','a','Resultado')").run()
  await env.DB.prepare("INSERT INTO sequences(id,workspace_id,name) VALUES('nurture','a','Nutrição')").run()
})
it('persiste rascunho separado, publica, ativa, duplica, conta e isola workspace e papel', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rede proibida'))
  try {
    const id = await publish()
    expect((await request(`rules/${id}`, 'PUT', config({ actions: [{ type: 'add_tag', tag_id: 'result' }] }))).status).toBe(200)
    expect((await request('contacts/c-a/tags', 'POST', { tag_id: 'lead', op: 'add' })).status).toBe(200)
    expect(await env.DB.prepare("SELECT sequence_id FROM sequence_subscriptions WHERE contact_id='c-a'").first('sequence_id')).toBe('nurture')
    expect(await env.DB.prepare("SELECT tag_id FROM contact_tags WHERE contact_id='c-a' AND tag_id='result'").first()).toBeNull()
    const rule = await (await request(`rules/${id}`)).json() as any
    expect(rule).toMatchObject({ active: true, executions: 1, unique_contacts: 1 })
    expect(rule.draft.actions[0].type).toBe('add_tag')
    expect(rule.published.actions[0].type).toBe('add_to_sequence')
    const copy = await (await request(`rules/${id}/duplicate`, 'POST')).json() as any
    expect(copy).toMatchObject({ active: false, executions: 0, published: null })
    expect((await request(`rules/${id}`, 'PATCH', { active: false })).status).toBe(200)
    expect((await authenticatedRequest(`rules/${id}`, 'b')).status).toBe(404)
    await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE workspace_id='a'").run()
    expect((await request(`rules/${id}`, 'DELETE')).status).toBe(403)
    expect(network).not.toHaveBeenCalled()
  } finally { network.mockRestore() }
})
it('recusa salvar sem gatilho, sem ação, data sem campo e referências de outro espaço', async () => {
  for (const input of [config({ trigger: undefined }), config({ actions: [] }), config({ trigger: { type: 'date' } }), config({ actions: [{ type: 'add_tag', tag_id: 'tag-b' }] })]) {
    expect((await request('rules', 'POST', input)).status).toBe(400)
  }
})
it('lote não dispara regras mesmo com um contato; perfil individual dispara', async () => {
  const id = await publish()
  expect((await request('contacts/bulk-tag', 'POST', { ids: ['c-a'], tag_id: 'lead', op: 'add' })).status).toBe(200)
  expect(await env.DB.prepare("SELECT sequence_id FROM sequence_subscriptions WHERE contact_id='c-a'").first()).toBeNull()
  const sequenceRule = await publish(config({ trigger: { type: 'sequence_entered' }, event_filter: { sequence_id: 'nurture' }, actions: [{ type: 'add_tag', tag_id: 'result' }] }))
  expect((await request('contacts/bulk-sequence', 'POST', { ids: ['c-a'], sequence_id: 'nurture' })).status).toBe(200)
  expect((await (await request(`rules/${sequenceRule}`)).json() as any).executions).toBe(0)
  await request('contacts/c-a/tags', 'POST', { tag_id: 'lead', op: 'remove' })
  await request('contacts/c-a/tags', 'POST', { tag_id: 'lead', op: 'add' })
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(1)
})

it('filtra evento, combina E/OU em dois níveis e aplica frequência e trava de 30 segundos', async () => {
  const { dispatchRules } = await import('../src/rules/runtime')
  const rule = await publish(config({ frequency: 'once', actions: [{ type: 'set_custom_field_value', field_id: 'field-a', value: 'Qualificado' }],
    condition: { match: 'all', groups: [{ match: 'any', rules: [{ type: 'tag', tag_id: 'result', operator: 'has' }, { type: 'tag', tag_id: 'tag-a', operator: 'has' }] },
      { match: 'all', rules: [{ type: 'field', field_id: 'field-a', operator: 'equals', value: 'Curso' }] }] } }))
  await request('contacts/c-a/tags', 'POST', { tag_id: 'result', op: 'add' })
  expect((await (await request(`rules/${rule}`)).json() as any).executions).toBe(0)
  await request('contacts/c-a/tags', 'POST', { tag_id: 'lead', op: 'add' })
  expect((await (await request(`rules/${rule}`)).json() as any).executions).toBe(1)
  const now = Date.now() + 31000
  await env.DB.prepare("UPDATE contact_field_values SET value='\"Curso\"' WHERE contact_id='c-a' AND field_id='field-a'").run()
  await env.DB.prepare("DELETE FROM contact_tags WHERE contact_id='c-a' AND tag_id='lead'").run()
  await env.DB.prepare("INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES('a','c-a','lead')").run()
  await dispatchRules(env, now, 'a')
  expect((await (await request(`rules/${rule}`)).json() as any).executions).toBe(1)
  const always = await publish(config({ actions: [{ type: 'add_tag', tag_id: 'result' }] }))
  for (const offset of [0, 1000, 31000]) {
    await env.DB.prepare("DELETE FROM contact_tags WHERE contact_id='c-a' AND tag_id='lead'").run()
    await env.DB.prepare("INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES('a','c-a','lead')").run()
    await dispatchRules(env, now + offset, 'a')
  }
  expect((await (await request(`rules/${always}`)).json() as any).executions).toBe(2)
})

it('agenda data no fuso do contato, repete por ano sem repetir no mesmo dia', async () => {
  const { dispatchRules } = await import('../src/rules/runtime')
  await env.DB.prepare("INSERT INTO custom_fields(id,workspace_id,name,type) VALUES('birthday','a','Aniversário','date')").run()
  await env.DB.prepare("UPDATE contacts SET timezone='America/Sao_Paulo' WHERE id='c-a'").run()
  // A publicação ainda não tem uma data para disparar. Só o scanner abaixo
  // recebe o valor, assim todos os instantes desta jornada são explícitos.
  const id = await publish(config({ trigger: { type: 'date', field_id: 'birthday', repeat_yearly: true, at_time: '09:00' }, event_filter: {}, actions: [{ type: 'add_tag', tag_id: 'result' }] }))
  await env.DB.prepare("INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES('a','c-a','birthday','\"2000-10-24\"')").run()
  await dispatchRules(env, Date.parse('2027-10-24T11:59:00Z'), 'a', { dates: true })
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(0)
  await dispatchRules(env, Date.parse('2027-10-24T12:00:00Z'), 'a', { dates: true })
  await dispatchRules(env, Date.parse('2027-10-24T12:01:00Z'), 'a', { dates: true })
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(1)
  await dispatchRules(env, Date.parse('2028-10-24T12:00:00Z'), 'a', { dates: true })
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(2)
})

it('reage a remoção de tag, mudança de campo, contato novo e entrada em sequência', async () => {
  const { dispatchRules } = await import('../src/rules/runtime')
  const rules = []
  for (const [type, filter] of [['tag_removed', { tag_id: 'tag-a' }], ['field_changed', { field_id: 'field-a', operator: 'equals', value: 'Recife' }],
    ['contact_created', {}], ['sequence_entered', { sequence_id: 'nurture' }]] as const) {
    rules.push(await publish(config({ trigger: { type }, event_filter: filter, actions: [{ type: 'add_tag', tag_id: 'result' }] })))
  }
  await request('contacts/c-a/tags', 'POST', { tag_id: 'tag-a', op: 'remove' })
  await request('contacts/c-a/fields/field-a', 'PUT', { value: 'Recife' })
  await env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name) VALUES('new-contact','a','Nova')").run()
  await env.DB.prepare("INSERT INTO sequence_subscriptions(workspace_id,sequence_id,contact_id,channel_id,enrollment_id) VALUES('a','nurture','c-a','ch-a','enrollment')").run()
  await dispatchRules(env, Date.now(), 'a')
  for (const rule of rules) expect((await (await request(`rules/${rule}`)).json() as any).executions).toBe(1)
})

it('recusa operadores incompatíveis com o tipo do campo no filtro e na condição', async () => {
  await env.DB.prepare("INSERT INTO custom_fields(id,workspace_id,name,type) VALUES('amount','a','Quantidade','number')").run()
  const invalid = [
    config({ trigger: { type: 'field_changed' }, event_filter: { field_id: 'amount', operator: 'contains', value: '1' } }),
    config({ condition: { match: 'all', groups: [{ match: 'all', rules: [{ type: 'field', field_id: 'field-a', operator: 'gte', value: 'A' }] }] } }),
  ]
  for (const input of invalid) expect((await request('rules', 'POST', input)).status).toBe(400)
})

it('recupera criação do workflow sem repetir ações nem reavaliar condição já alterada', async () => {
  const { dispatchRules } = await import('../src/rules/runtime')
  const { publishAutomation } = await import('../src/db/automations')
  await publishAutomation(env.DB, 'a', 'auto-a')
  const id = await publish(config({ condition: { match: 'all', groups: [{ match: 'all', rules: [{ type: 'field', field_id: 'field-a', operator: 'equals', value: 'Curso' }] }] },
    actions: [{ type: 'set_custom_field_value', field_id: 'field-a', value: 'Qualificado' }, { type: 'add_tag', tag_id: 'result' },
      { type: 'remove_tag', tag_id: 'result' }, { type: 'start_automation', automation_id: 'auto-a' }] }))
  const flow = { create: vi.fn().mockRejectedValueOnce(new Error('Indisponível')).mockResolvedValue({ id: 'local' }),
    get: vi.fn().mockRejectedValue(new Error('Ainda não existe')) }
  const bindings = { ...env, FLOW_RUN: flow } as unknown as typeof env
  await env.DB.prepare("INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES('a','c-a','lead')").run()
  expect((await dispatchRules(bindings, Date.now(), 'a')).failed).toBeGreaterThan(0)
  const retryAt = await env.DB.prepare("SELECT retry_at FROM rule_events WHERE type='tag_added' AND resource_id='lead'").first<number>('retry_at')
  await dispatchRules(bindings, retryAt!, 'a')
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(1)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM rule_events WHERE type='tag_added' AND resource_id='result'").first('n')).toBe(1)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM flow_runs WHERE id LIKE 'rule-%'").first('n')).toBe(1)
  expect(flow.create).toHaveBeenCalledTimes(2)
})

it('converte datetime UTC no fuso do contato e aplica deslocamento cruzando a meia-noite', async () => {
  const { dispatchRules } = await import('../src/rules/runtime')
  await env.DB.prepare("INSERT INTO custom_fields(id,workspace_id,name,type) VALUES('appointment','a','Encontro','datetime')").run()
  await env.DB.prepare("INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES('a','c-a','appointment','\"2027-10-25T01:00:00Z\"')").run()
  await env.DB.prepare("UPDATE contacts SET timezone='America/Sao_Paulo' WHERE id='c-a'").run()
  const id = await publish(config({ trigger: { type: 'date', field_id: 'appointment', offset_seconds: 10800 }, event_filter: {}, actions: [{ type: 'add_tag', tag_id: 'result' }] }))
  await dispatchRules(env, Date.parse('2027-10-25T03:59:00Z'), 'a', { dates: true })
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(0)
  await dispatchRules(env, Date.parse('2027-10-25T04:00:00Z'), 'a', { dates: true })
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(1)
})

it('tag aplicada por clique individual de e-mail dispara regra global sem envio externo', async () => {
  const { runEmailInteraction } = await import('../src/email-channel/events')
  const { dispatchRules } = await import('../src/rules/runtime')
  const id = await publish()
  const mail: import('../src/email-channel/service').StoredEmail = {
    id: 'mail-local', workspace_id: 'a', connection_id: 'ch-a', contact_id: 'c-a', sender_id: 'sender-local',
    recipient: 'contato@example.test', message_id: 'message-local', provider_message_id: null,
    reply_to: 'resposta@example.test', token: 'local-only', subject: 'Conteúdo local', preheader: '', text: 'Texto', html: '<p>Texto</p>',
    intent: 'automation', status: 'sent', created_at: Date.now(),
    metadata: JSON.stringify({ linkActions: [{ url: 'https://example.test/seguir', actions: [{ type: 'add_tag', tag_id: 'lead' }] }] }),
  }
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rede proibida'))
  try {
    await runEmailInteraction(env, mail, 'clicked', 'click-local', 'https://example.test/seguir')
    await dispatchRules(env, Date.now(), 'a')
    expect(await env.DB.prepare("SELECT sequence_id FROM sequence_subscriptions WHERE contact_id='c-a'").first('sequence_id')).toBe('nurture')
    expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(1)
    expect(network).not.toHaveBeenCalled()
  } finally { network.mockRestore() }
})

it('cem eventos sem conexão são ignorados com motivo sem bloquear o próximo contato elegível', async () => {
  const { dispatchRules } = await import('../src/rules/runtime')
  const id = await publish(config({ trigger: { type: 'contact_created' }, event_filter: {} }))
  await env.DB.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM numbers WHERE n<99)
    INSERT INTO contacts(id,workspace_id,first_name) SELECT printf('poison-%03d',n),'a','Sem conexão' FROM numbers`).run()
  const at = Date.now()
  await env.DB.prepare("UPDATE rule_events SET created_at=? WHERE contact_id LIKE 'poison-%'").bind(at).run()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name) VALUES('good-after-poison','a','Elegível')"),
    env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES('cc-good','a','good-after-poison','ch-a','good',1)"),
  ])
  await env.DB.prepare("UPDATE rule_events SET created_at=? WHERE contact_id='good-after-poison'").bind(at+1).run()
  await dispatchRules(env,at+1,'a')
  expect(await env.DB.prepare("SELECT sequence_id FROM sequence_subscriptions WHERE contact_id='good-after-poison'").first('sequence_id')).toBe('nurture')
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(1)
  expect(await env.DB.prepare("SELECT count(*) FROM rule_events WHERE contact_id LIKE 'poison-%' AND processed_at IS NOT NULL").first('count(*)')).toBe(100)
  expect(await env.DB.prepare("SELECT count(*) FROM rule_executions WHERE contact_id LIKE 'poison-%' AND skipped_at IS NOT NULL AND skip_reason IS NOT NULL AND completed_at IS NULL").first('count(*)')).toBe(100)
})

it('falha transitória ganha backoff enquanto eventos seguintes continuam sendo processados', async () => {
  const { dispatchRules } = await import('../src/rules/runtime')
  const { publishAutomation } = await import('../src/db/automations')
  await publishAutomation(env.DB,'a','auto-a')
  await publish(config({ actions: [{ type: 'start_automation', automation_id: 'auto-a' }] }))
  await publish(config({ trigger: { type: 'field_changed' }, event_filter: { field_id: 'field-a', operator: 'equals', value: 'Recuperado' }, actions: [{ type: 'add_tag', tag_id: 'result' }] }))
  const flow = { create: vi.fn().mockRejectedValue(new Error('Executor temporariamente indisponível')), get: vi.fn().mockRejectedValue(new Error('Ainda não existe')) }
  const bindings = { ...env,FLOW_RUN: flow } as unknown as typeof env
  await env.DB.prepare("INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES('a','c-a','lead')").run()
  await env.DB.prepare("UPDATE contact_field_values SET value='\"Recuperado\"' WHERE contact_id='c-a' AND field_id='field-a'").run()
  const now = Date.now()
  await dispatchRules(bindings,now,'a')
  expect(await env.DB.prepare("SELECT tag_id FROM contact_tags WHERE contact_id='c-a' AND tag_id='result'").first('tag_id')).toBe('result')
  expect(flow.create).toHaveBeenCalledTimes(1)
  const event = await env.DB.prepare("SELECT retry_at,attempts,last_error FROM rule_events WHERE type='tag_added' AND resource_id='lead'").first<any>()
  expect(event).toMatchObject({ attempts: 1, last_error: expect.any(String) })
  expect(event.retry_at).toBeGreaterThan(now)
  await dispatchRules(bindings,now+1,'a')
  expect(flow.create).toHaveBeenCalledTimes(1)
  await dispatchRules(bindings,event.retry_at,'a')
  expect(flow.create).toHaveBeenCalledTimes(2)
})

it('erro de um contato de data não impede o contato elegível seguinte', async () => {
  const { dispatchRules } = await import('../src/rules/runtime')
  await env.DB.prepare("INSERT INTO custom_fields(id,workspace_id,name,type) VALUES('scheduled-date','a','Dia marcado','date')").run()
  const id = await publish(config({ trigger: { type: 'date', field_id: 'scheduled-date' }, event_filter: {} }))
  await env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name) VALUES('a-date-bad','a','Sem conexão')").run()
  await env.DB.batch(['a-date-bad','c-a'].map(contact => env.DB.prepare("INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES('a',?,'scheduled-date','\"2027-10-24\"')").bind(contact)))
  await dispatchRules(env,Date.parse('2027-10-24T12:00:00Z'),'a',{ dates: true })
  expect(await env.DB.prepare("SELECT sequence_id FROM sequence_subscriptions WHERE contact_id='c-a'").first('sequence_id')).toBe('nurture')
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(1)
})

it.each(['tag','field'] as const)('excluir %s em configurações não dispara regras pelas remoções em cascata', async kind => {
  const id = await publish(config({ trigger: { type: kind === 'tag' ? 'tag_removed' : 'field_changed' }, event_filter: {}, actions: [{ type: 'add_tag', tag_id: 'result' }] }))
  expect((await request(kind === 'tag' ? 'tags/tag-a' : 'fields/field-a','DELETE')).status).toBe(200)
  expect(await env.DB.prepare("SELECT tag_id FROM contact_tags WHERE contact_id='c-a' AND tag_id='result'").first()).toBeNull()
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(0)
  expect(await env.DB.prepare("SELECT count(*) FROM rule_events WHERE type=? AND resource_id=?").bind(kind === 'tag' ? 'tag_removed' : 'field_changed',kind === 'tag' ? 'tag-a' : 'field-a').first('count(*)')).toBe(kind === 'tag' ? 0 : 1)
})

it('a conversão de legado exige reconfiguração para evento desconhecido e omite filtro e campo inválidos', async () => {
  await env.DB.prepare(`INSERT INTO rules(id,workspace_id,name,kind,event_type,event_config,action_type,http_request)
    VALUES('legacy-unknown','a','Legada','internal_event','custom_event_triggered','[]','http_request','{}')`).run()
  const migration = env.TEST_MIGRATIONS.find(migration => migration.name.endsWith('_rules.sql'))!
  const convert = migration.queries.find(query => query.includes('UPDATE rules SET draft='))!
  expect(convert).toBeTruthy()
  await env.DB.prepare(convert).run()
  const rule = await (await request('rules/legacy-unknown')).json() as any
  expect(rule.draft.trigger.type).not.toBe('contact_created')
  expect(rule.draft.trigger).not.toHaveProperty('field_id')
  expect(rule.draft.event_filter).toEqual({})
})

it.each(['publish','duplicate'] as const)('rascunho legado inválido retorna400 ao %s', async action => {
  await env.DB.prepare(`INSERT INTO rules(id,workspace_id,name,kind,event_type,action_type,http_request,draft)
    VALUES('legacy-invalid','a','Legada','internal_event','custom_event_triggered','http_request','{}',?)`)
    .bind(JSON.stringify({ trigger: {},event_filter: {},actions: [],frequency: 'always' })).run()
  expect((await request(`rules/legacy-invalid/${action}`,'POST')).status).toBe(400)
})

it('apenas cron agenda datas: mutação HTTP e fila drenam eventos sem varrer datas', async () => {
  const { default: worker } = await import('../src/index')
  const { dispatchRules } = await import('../src/rules/runtime')
  await env.DB.prepare("INSERT INTO custom_fields(id,workspace_id,name,type) VALUES('today','a','Hoje','date')").run()
  await env.DB.prepare("UPDATE contacts SET timezone='UTC' WHERE id='c-a'").run()
  const id = await publish(config({ trigger: { type: 'date', field_id: 'today' }, event_filter: {}, actions: [{ type: 'add_tag', tag_id: 'result' }] }))
  await env.DB.prepare("INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES('a','c-a','today',?)").bind(JSON.stringify(new Date().toISOString().slice(0,10))).run()
  expect((await request('contacts/c-a','PATCH',{ first_name: 'Atualizada' })).status).toBe(200)
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(0)
  await worker.queue({ queue: 'local',messages: [],metadata: { metrics: { backlogCount: 0,backlogBytes: 0 } },ackAll() {},retryAll() {} },env)
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(0)
  await dispatchRules(env,Date.now(),'a',{ dates: true })
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(1)
})

it('falha no scanner pós-escrita preserva200 e a alteração persistida do perfil', async () => {
  const db = new Proxy(env.DB,{
    get(target,key) {
      if (key === 'prepare') return (query: string) => {
        if (query.includes('FROM rules WHERE active=1')) throw new Error('Scanner temporariamente indisponível')
        return target.prepare(query)
      }
      const member = Reflect.get(target,key,target)
      return typeof member === 'function' ? member.bind(target) : member
    },
  })
  const response = await authenticatedRequest('contacts/c-a','a',{ method: 'PATCH',body: JSON.stringify({ first_name: 'Persistiu' }) },undefined,{ ...env,DB: db })
  expect(await env.DB.prepare("SELECT first_name FROM contacts WHERE id='c-a'").first('first_name')).toBe('Persistiu')
  expect(response.status).toBe(200)
})

it('cron recupera regra de data pendente depois da meia-noite sem repetir ações', async () => {
  const { dispatchRules } = await import('../src/rules/runtime')
  const { publishAutomation } = await import('../src/db/automations')
  await publishAutomation(env.DB,'a','auto-a')
  await env.DB.prepare("INSERT INTO custom_fields(id,workspace_id,name,type) VALUES('last-minute','a','Último minuto','date')").run()
  await env.DB.prepare("UPDATE contacts SET timezone='UTC' WHERE id='c-a'").run()
  const id = await publish(config({ trigger: { type: 'date',field_id: 'last-minute',at_time: '23:59' },event_filter: {},frequency: 'once',
    actions: [{ type: 'add_tag',tag_id: 'result' },{ type: 'remove_tag',tag_id: 'result' },{ type: 'start_automation',automation_id: 'auto-a' }] }))
  await env.DB.prepare("INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES('a','c-a','last-minute','\"2027-10-24\"')").run()
  const flow = { create: vi.fn().mockRejectedValueOnce(new Error('Executor indisponível')).mockResolvedValue({ id: 'local' }),get: vi.fn().mockRejectedValue(new Error('Ainda não existe')) }
  const bindings = { ...env,FLOW_RUN: flow } as unknown as typeof env
  expect((await dispatchRules(bindings,Date.parse('2027-10-24T23:59:00Z'),'a',{ dates: true })).failed).toBe(1)
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(0)
  await dispatchRules(bindings,Date.parse('2027-10-25T00:00:00Z'),'a',{ dates: true })
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(1)
  expect(flow.create).toHaveBeenCalledTimes(2)
  expect(await env.DB.prepare("SELECT count(*) FROM rule_events WHERE type='tag_added' AND resource_id='result'").first('count(*)')).toBe(1)
  expect(await env.DB.prepare("SELECT count(*) FROM flow_runs WHERE id LIKE 'rule-%'").first('count(*)')).toBe(1)
})

it('scanner indisponível não desfaz fila concluída nem impede o cron das sequências', async () => {
  const { default: worker } = await import('../src/index')
  const { publishAutomation } = await import('../src/db/automations')
  await publishAutomation(env.DB,'a','auto-a')
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sequence_steps(id,workspace_id,sequence_id,automation_id,position,status) VALUES('sequence-step','a','nurture','auto-a',0,'live')"),
    env.DB.prepare("INSERT INTO sequence_subscriptions(workspace_id,sequence_id,contact_id,channel_id,enrollment_id,next_step,next_at) VALUES('a','nurture','c-a','ch-a','local-enrollment',0,0)"),
  ])
  const db = new Proxy(env.DB,{
    get(target,key) {
      if (key === 'prepare') return (query: string) => {
        if (query.includes('FROM rules WHERE active=1')) throw new Error('Scanner indisponível')
        return target.prepare(query)
      }
      const member = Reflect.get(target,key,target)
      return typeof member === 'function' ? member.bind(target) : member
    },
  })
  const flow = { create: vi.fn().mockResolvedValue({ id: 'local' }),get: vi.fn() }
  const bindings = { ...env,DB: db,FLOW_RUN: flow } as unknown as typeof env
  await expect(worker.queue({ queue: 'local',messages: [],metadata: { metrics: { backlogCount: 0,backlogBytes: 0 } },ackAll() {},retryAll() {} },bindings)).resolves.toBeUndefined()
  await expect(worker.scheduled({ cron: '* * * * *',scheduledTime: Date.now(),noRetry() {} },bindings)).resolves.toBeUndefined()
  expect(flow.create).toHaveBeenCalledTimes(1)
  expect(await env.DB.prepare("SELECT count(*) FROM sequence_flow_runs WHERE sequence_id='nurture'").first('count(*)')).toBe(1)
})

it('regras de e-mail permanecem no editor próprio e não aparecem no CRUD global', async () => {
  const response = await request('email/rules','POST',{ name: 'Abertura do conteúdo',event: 'email_opened',automationId: 'auto-a' })
  expect(response.status).toBe(201)
  const email = await response.json() as { id: string }
  expect(await (await request('rules')).json()).toEqual([])
  expect((await request(`rules/${email.id}`)).status).toBe(404)
  expect((await request('email/rules')).status).toBe(200)
})

it('importação CSV dispara a regra de novo contato só para quem foi criado, e não emite eventos por tags ou campos', async () => {
  const { consumeContactImport } = await import('../src/contact-import-worker')
  const { dispatchRules } = await import('../src/rules/runtime')
  for (const type of ['contact_created','tag_added','field_changed']) await publish(config({ trigger: { type },event_filter: {},actions: [{ type: 'add_tag',tag_id: 'result' }] }))
  const response = await request('contact-imports','POST',{
    file_name: 'leads.csv',
    csv: 'email,nome,cidade\nnova@example.test,Nova,Recife\na@example.test,Existente,Olinda',
    mapping: { email: 0,first_name: 1,'field:field-a': 2 },tag_ids: ['lead'],consent: true,
  })
  expect(response.status).toBe(202)
  const job = await response.json() as { id: string }
  await consumeContactImport({ body: { kind: 'contact_import',workspaceId: 'a',importId: job.id },attempts: 1,ack() {},retry() {} } as unknown as Message<unknown>,env)
  await dispatchRules(env,Date.now(),'a')
  const executions = (await (await request('rules')).json() as { executions: number; draft: { trigger: { type: string } } }[]).map(rule => [rule.draft.trigger.type, rule.executions])
  const created = await env.DB.prepare("SELECT count(*) FROM contacts WHERE optin_source='import'").first<number>('count(*)')
  // tag_added só aparece pela ação da regra de novo contato (encadeamento normal), nunca pelas tags da própria importação.
  expect(Object.fromEntries(executions)).toMatchObject({ contact_created: created, field_changed: 0 })
  expect(await env.DB.prepare("SELECT count(*) FROM contact_tags WHERE tag_id='result'").first('count(*)')).toBe(created)
  expect(await env.DB.prepare('SELECT count(*) FROM rule_event_suppressions').first('count(*)')).toBe(0)
})

it('excluir contato apaga os dados preservados em eventos e execuções das regras', async () => {
  await publish(config({ trigger: { type: 'field_changed' },event_filter: {},actions: [{ type: 'add_tag',tag_id: 'result' }] }))
  await request('contacts/c-a/fields/field-a','PUT',{ value: 'Informação privada' })
  expect(await env.DB.prepare("SELECT count(*) FROM rule_events WHERE contact_id='c-a' AND value LIKE '%privada%'").first('count(*)')).toBe(1)
  expect((await request('contacts/c-a','DELETE')).status).toBe(200)
  for (const table of ['rule_events','rule_executions']) expect(await env.DB.prepare(`SELECT count(*) FROM ${table} WHERE contact_id='c-a'`).first('count(*)')).toBe(0)
})

it('republicação preserva recuperação da execução anterior sem repetir suas ações', async () => {
  const { dispatchRules } = await import('../src/rules/runtime')
  const { publishAutomation } = await import('../src/db/automations')
  await publishAutomation(env.DB,'a','auto-a')
  const id = await publish(config({ actions: [{ type: 'add_tag',tag_id: 'result' },{ type: 'remove_tag',tag_id: 'result' },{ type: 'start_automation',automation_id: 'auto-a' }] }))
  const flow = { create: vi.fn().mockRejectedValueOnce(new Error('Executor indisponível')).mockResolvedValue({ id: 'local' }),get: vi.fn().mockRejectedValue(new Error('Ainda não existe')) }
  const bindings = { ...env,FLOW_RUN: flow } as unknown as typeof env
  await env.DB.prepare("INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES('a','c-a','lead')").run()
  const now = Date.now()
  expect((await dispatchRules(bindings,now,'a')).failed).toBe(1)
  // A próxima publicação acontece depois do evento original e antes da tentativa seguinte.
  await env.DB.prepare('UPDATE rules SET published_at=? WHERE id=?').bind(now+1000,id).run()
  await dispatchRules(bindings,now+31000,'a')
  expect((await (await request(`rules/${id}`)).json() as any).executions).toBe(1)
  expect(flow.create).toHaveBeenCalledTimes(2)
  expect(await env.DB.prepare("SELECT count(*) FROM rule_events WHERE type='tag_added' AND resource_id='result'").first('count(*)')).toBe(1)
})

it('salvar regra ativa devolve need_activate; rascunho nunca ativado não pede', async () => {
  const draft = await create()
  expect((await (await request(`rules/${draft.id}`, 'PUT', config())).json() as any).need_activate).toBe(false)
  const live = await publish()
  expect((await (await request(`rules/${live}`, 'PUT', config())).json() as any).need_activate).toBe(true)
})
