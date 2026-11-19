import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import { seed, graph } from '../test/fixtures'
import { condition } from '../src/flow/nodes'
import { delayDeadline } from '../src/flow/timing'
import { publishAutomation } from '../src/db/automations'

const run: any = { id: 'run-advanced', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', automation_id: 'auto-a' }
const stamp = (date: string) => Date.parse(date)
const filter = (rule: unknown) => ({ match: 'all', rules: [rule] })
beforeEach(async () => {
  await seed()
  await env.DB.batch([
    env.DB.prepare("UPDATE contacts SET timezone='America/New_York' WHERE id='c-a'"),
    env.DB.prepare("INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('date-a','a','Encontro','date'),('date-other','a','Outra data','date'),('datetime-a','a','Instante','datetime')"),
    env.DB.prepare("INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES ('a','c-a','date-a','\"2026-03-09T09:00\"'),('a','c-a','date-other','\"2026-03-08T09:00\"')"),
    env.DB.prepare("INSERT INTO sequences(id,workspace_id,name) VALUES ('seq-a','a','Acompanhamento'),('seq-b','b','Outro espaço')"),
    env.DB.prepare("INSERT INTO sequence_subscriptions(workspace_id,sequence_id,contact_id) VALUES ('a','seq-a','c-a')"),
    env.DB.prepare("INSERT INTO segments(id,workspace_id,name,filter) VALUES ('seg-a','a','Clientes',?)").bind(JSON.stringify(filter({ type: 'tag', tag_id: 'tag-a', operator: 'has' }))),
  ])
})
afterEach(() => vi.restoreAllMocks())

it('espera por duração alcança o próximo dia permitido e acompanha mudança de fuso no horário de verão', async () => {
  const config = { duration: { value: 1, unit: 'hours' }, window: { from: '09:00', to: '18:00', days: [0] } }
  expect(await delayDeadline(env.DB, run, config, stamp('2026-03-07T22:00:00Z'))).toBe(stamp('2026-03-08T13:00:00Z'))
  expect(await delayDeadline(env.DB, run, { ...config, timezone: 'America/Sao_Paulo' }, stamp('2026-03-07T22:00:00Z'))).toBe(stamp('2026-03-08T12:00:00Z'))
})
it('data fixa e campo respeitam deslocamento em dias civis e horários inexistentes na transição DST', async () => {
  expect(await delayDeadline(env.DB, run, { mode: 'date', date: { kind: 'field', field_id: 'date-a' }, offset: { value: 1, unit: 'days', direction: 'before' } }, stamp('2026-03-07T12:00:00Z'))).toBe(stamp('2026-03-08T13:00:00Z'))
  expect(await delayDeadline(env.DB, run, { mode: 'date', date: { kind: 'specific', at: '2026-03-08T02:30' } }, stamp('2026-03-07T12:00:00Z'))).toBe(stamp('2026-03-08T07:30:00Z'))
  expect(await delayDeadline(env.DB, run, { mode: 'date', date: { kind: 'specific', at: '2026-11-01T01:30' } }, stamp('2026-10-31T12:00:00Z'))).toBe(stamp('2026-11-01T05:30:00Z'))
})
it('condição combina sequência, horário, segmento dinâmico e comparação de datas com deslocamento', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(stamp('2026-03-08T13:30:00Z'))
  expect(await condition(env, run, { match: 'all', rules: [
    { type: 'sequence', sequence_id: 'seq-a', operator: 'has' },
    { type: 'current_time', timezone: 'America/New_York', window: { from: '09:00', to: '10:00', days: [0] } },
    { type: 'segment', segment_id: 'seg-a', operator: 'has' },
    { type: 'date', field_id: 'date-a', operator: 'equals', compare: { kind: 'field', field_id: 'date-other' }, offset: { value: 1, unit: 'days', direction: 'after' } },
  ] })).toBe('true')
  expect(await condition(env, run, filter({ type: 'sequence', sequence_id: 'seq-a', operator: 'not_has' }))).toBe('false')
  expect(await condition(env, run, filter({ type: 'current_time', window: { from: '22:00', to: '02:00', days: [6] } }))).toBe('false')
  await env.DB.prepare("DELETE FROM contact_tags WHERE contact_id='c-a'").run()
  expect(await condition(env, run, filter({ type: 'segment', segment_id: 'seg-a', operator: 'has' }))).toBe('false')
})
it('publicação recusa referência de outro workspace, campo sem tipo data e janela/fuso inválidos', async () => {
  for (const [type, config] of [
    ['smart_delay', { mode: 'date', date: { kind: 'specific', at: '2026-02-30T10:00' } }],
    ['smart_delay', { mode: 'date', date: { kind: 'specific', at: '2026-10-24' }, offset: { value: 1000000, unit: 'days', direction: 'after' } }],
    ['condition', filter({ type: 'date', field_id: 'date-a', operator: 'equals', compare: { kind: 'field', field_id: 'datetime-a' } })],
    ['condition', filter({ type: 'sequence', sequence_id: 'seq-b', operator: 'has' })],
    ['smart_delay', { mode: 'date', date: { kind: 'field', field_id: 'field-a' } }],
    ['smart_delay', { duration: { value: 1, unit: 'hours' }, window: { from: '25:00', to: '08:00', days: [] } }],
    ['condition', filter({ type: 'current_time', timezone: 'Sem/Fuso', window: { from: '09:00', to: '10:00', days: [1] } })],
  ] as const) {
    const draft = { nodes: [...graph.nodes, { id: 'logic', type, position: { x: 0, y: 0 }, config }], edges: graph.edges }
    await env.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(JSON.stringify(draft)).run()
    await expect(publishAutomation(env.DB, 'a', 'auto-a')).rejects.toThrow()
  }
})

it('janela noturna atribui madrugada ao dia de abertura e usa fuso da conta para o horário atual', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(stamp('2026-03-08T04:30:00Z'))
  expect(await condition(env, run, filter({ type: 'current_time', window: { from: '22:00', to: '02:00', days: [6] } }))).toBe('true')
  expect(await condition(env, run, filter({ type: 'current_time', window: { from: '22:00', to: '02:00', days: [0] } }))).toBe('false')
  await env.DB.prepare("UPDATE contacts SET timezone='fuso-antigo-invalido' WHERE id='c-a'").run()
  expect(await delayDeadline(env.DB, run, { duration: { value: 1, unit: 'hours' }, window: { from: '09:00', to: '18:00', days: [0] } }, Date.now())).toBe(stamp('2026-03-08T12:00:00Z'))
})
it('data ausente não passa na condição nem inicia uma espera sem prazo', async () => {
  await env.DB.prepare("DELETE FROM contact_field_values WHERE field_id='date-a'").run()
  expect(await condition(env, run, filter({ type: 'date', field_id: 'date-a', operator: 'before', compare: { kind: 'specific', at: '2026-10-24' } }))).toBe('false')
  await expect(delayDeadline(env.DB, run, { mode: 'date', date: { kind: 'field', field_id: 'date-a' } }, Date.now())).rejects.toThrow(/vazio ou inválido/)
})

it('condição antiga sem regras mantém o caminho positivo em todos e qualquer', async () => {
  for (const match of ['all', 'any']) {
    expect(await condition(env, run, { match, rules: [] })).toBe('true')
  }
})
