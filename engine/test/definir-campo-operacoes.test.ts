import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { seed, graph } from './fixtures'
import { actions } from '../src/flow/nodes'
import { applyFieldOperation } from '../src/flow/field-operations'
import { messageVariable } from '../src/schemas/message-variables'
import { actionSchema, validateActionReference } from '../src/schemas/actions'
import type { FlowEnv, Run } from '../src/flow/types'

const bindings = env as unknown as FlowEnv
const run = { id: 'campo-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', automation_id: 'auto-a' } as Run
let step = 0
const apply = (list: unknown[]) => actions(bindings, run, { actions: list }, ++step)
const stored = async (field: string) => {
  const row = await bindings.DB.prepare('SELECT value FROM contact_field_values WHERE contact_id=? AND field_id=?').bind('c-a', field).first<{ value: string }>()
  return row ? JSON.parse(row.value) as unknown : undefined
}
const NOW = Date.parse('2026-10-25T12:00:00Z')

beforeEach(async () => {
  await seed()
  step = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  bindings.FLOW_RUN = { get: vi.fn(async () => ({ terminate: vi.fn() })) } as any
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('campo-version','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    bindings.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,channel_id,automation_version_id) VALUES ('campo-run','a','c-a','ch-a','campo-version')"),
    bindings.DB.prepare("INSERT INTO custom_fields (id,workspace_id,name,type) VALUES ('pontos','a','Pontos','number'),('prazo','a','Prazo','date'),('visto','a','Visto em','datetime'),('apelido','a','Apelido','text'),('vip','a','VIP','boolean')"),
  ])
})
afterEach(() => vi.useRealTimers())

it('número: campo vazio conta como zero; somar e subtrair acumulam, inclusive duas vezes no mesmo passo', async () => {
  await apply([{ type: 'set_custom_field_value', field_id: 'pontos', operation: 'add', value: 10 }])
  expect(await stored('pontos')).toBe(10)
  await apply([{ type: 'set_custom_field_value', field_id: 'pontos', operation: 'subtract', value: 3.5 }])
  expect(await stored('pontos')).toBe(6.5)
  await apply([{ type: 'set_custom_field_value', field_id: 'pontos', operation: 'add', value: 1 }, { type: 'set_custom_field_value', field_id: 'pontos', operation: 'add', value: 1 }])
  expect(await stored('pontos')).toBe(8.5)
  await apply([{ type: 'set_custom_field_value', field_id: 'pontos', value: 100 }])
  expect(await stored('pontos')).toBe(100)
})

it('número: soma inteira grava o texto canônico ("3", não "3.0"), que buscas por valor exato encontram', async () => {
  const raw = async () => (await bindings.DB.prepare("SELECT value FROM contact_field_values WHERE contact_id='c-a' AND field_id='pontos'").first<{ value: string }>())?.value
  await apply([{ type: 'set_custom_field_value', field_id: 'pontos', operation: 'add', value: 5 }, { type: 'set_custom_field_value', field_id: 'pontos', operation: 'subtract', value: 2 }])
  expect(await raw()).toBe('3')
  await apply([{ type: 'set_custom_field_value', field_id: 'pontos', operation: 'add', value: 5 }])
  expect(await raw()).toBe('8')
  await apply([{ type: 'set_custom_field_value', field_id: 'pontos', operation: 'subtract', value: 0.5 }])
  expect(await raw()).toBe('7.5')
})

it('número: subtrair de campo vazio dá negativo e o replay do mesmo passo não soma de novo', async () => {
  const config = { actions: [{ type: 'set_custom_field_value', field_id: 'pontos', operation: 'subtract', value: 4 }] }
  await actions(bindings, run, config, 50)
  await actions(bindings, run, config, 50)
  expect(await stored('pontos')).toBe(-4)
})

it('número: o valor pode vir de outra variável, com valor padrão quando ela está vazia', async () => {
  await bindings.DB.prepare("INSERT INTO custom_fields (id,workspace_id,name,type) VALUES ('bonus','a','Bônus','text')").run()
  const value = messageVariable('campo:bonus', '5')
  await apply([{ type: 'set_custom_field_value', field_id: 'pontos', operation: 'add', value }])
  expect(await stored('pontos')).toBe(5)
  await bindings.DB.prepare("INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value) VALUES ('a','c-a','bonus','\"20\"')").run()
  await apply([{ type: 'set_custom_field_value', field_id: 'pontos', operation: 'add', value }])
  expect(await stored('pontos')).toBe(25)
  await apply([{ type: 'set_custom_field_value', field_id: 'pontos', operation: 'add', value: 'não é número' }])
  expect(await stored('pontos')).toBe(25)
})

it('texto: definir com variável e valor padrão, e limpar', async () => {
  await apply([{ type: 'set_custom_field_value', field_id: 'apelido', operation: 'set', value: `Oi ${messageVariable('primeiro_nome', 'amigo')}` }])
  expect(await stored('apelido')).toBe('Oi Mariana')
  await apply([{ type: 'set_custom_field_value', field_id: 'apelido', value: `Plano ${messageVariable('campo:visto', 'novo')}` }])
  expect(await stored('apelido')).toBe('Plano novo')
  await apply([{ type: 'set_custom_field_value', field_id: 'apelido', operation: 'clear' }])
  expect(await stored('apelido')).toBeUndefined()
})

it('data: somar dias parte de hoje quando vazia, aceita negativo e preserva o formato do tipo', async () => {
  await apply([{ type: 'set_custom_field_value', field_id: 'prazo', operation: 'add_days', value: 7 }])
  expect(await stored('prazo')).toBe('2026-11-01')
  await apply([{ type: 'set_custom_field_value', field_id: 'prazo', operation: 'add_days', value: -2 }])
  expect(await stored('prazo')).toBe('2026-10-30')
  await apply([{ type: 'set_custom_field_value', field_id: 'visto', operation: 'add_days', value: 1 }])
  expect(await stored('visto')).toBe('2026-10-26T12:00:00.000Z')
  await apply([{ type: 'set_custom_field_value', field_id: 'visto', operation: 'add_days', value: 1 }])
  expect(await stored('visto')).toBe('2026-10-27T12:00:00.000Z')
})

it('data: definir como agora grava a data (ou data e hora) do momento', async () => {
  await apply([{ type: 'set_custom_field_value', field_id: 'prazo', operation: 'set_now' }, { type: 'set_custom_field_value', field_id: 'visto', operation: 'set_now' }])
  expect(await stored('prazo')).toBe('2026-10-25')
  expect(await stored('visto')).toBe('2026-10-25T12:00:00.000Z')
})

it('ações antigas sem operação continuam definindo o valor tipado', async () => {
  await apply([{ type: 'set_custom_field_value', field_id: 'vip', value: false }, { type: 'set_custom_field_value', field_id: 'pontos', value: 0 }])
  expect(await stored('vip')).toBe(false)
  expect(await stored('pontos')).toBe(0)
  await expect(apply([{ type: 'set_custom_field_value', field_id: 'pontos', value: '12' }])).rejects.toThrow()
})

it('operação incompatível com o tipo do campo para o passo e a publicação recusa', async () => {
  await expect(apply([{ type: 'set_custom_field_value', field_id: 'apelido', operation: 'add', value: 1 }])).rejects.toThrow()
  const bad = actionSchema.parse({ type: 'set_custom_field_value', field_id: 'apelido', operation: 'add_days', value: 1 })
  await expect(validateActionReference(bindings.DB, 'a', bad)).rejects.toThrow()
  const ok = actionSchema.parse({ type: 'set_custom_field_value', field_id: 'prazo', operation: 'add_days', value: 3 })
  await expect(validateActionReference(bindings.DB, 'a', ok)).resolves.toBeUndefined()
  await expect(validateActionReference(bindings.DB, 'a', actionSchema.parse({ type: 'set_custom_field_value', field_id: 'pontos', operation: 'add' }))).rejects.toThrow()
  await expect(validateActionReference(bindings.DB, 'b', ok)).rejects.toThrow()
  expect(() => actionSchema.parse({ type: 'set_custom_field_value', field_id: 'x', operation: 'multiplicar', value: 2 })).toThrow()
})

it('regras de cálculo puras', () => {
  expect(applyFieldOperation('number', 'add', '2', 3, NOW)).toEqual({ kind: 'value', value: 5 })
  expect(applyFieldOperation('number', 'add', 'x', 3, NOW)).toEqual({ kind: 'skip' })
  expect(applyFieldOperation('date', 'add_days', 1.5, null, NOW)).toEqual({ kind: 'skip' })
})

it('número: somas simultâneas de passos diferentes não perdem nenhuma', async () => {
  await Promise.all([1, 2, 3, 4, 5].map(n => actions(bindings, run, { actions: [{ type: 'set_custom_field_value', field_id: 'pontos', operation: 'add', value: 1 }] }, 200 + n)))
  expect(await stored('pontos')).toBe(5)
})

it('número: valor atual guardado como texto numérico é somado, e texto que não é número deixa o campo como está', async () => {
  await bindings.DB.prepare("INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value) VALUES ('a','c-a','pontos','\"20\"')").run()
  await apply([{ type: 'set_custom_field_value', field_id: 'pontos', operation: 'add', value: 5 }])
  expect(await stored('pontos')).toBe(25)
  await bindings.DB.prepare("UPDATE contact_field_values SET value='\"vinte\"' WHERE field_id='pontos'").run()
  await apply([{ type: 'set_custom_field_value', field_id: 'pontos', operation: 'add', value: 5 }])
  expect(await stored('pontos')).toBe('vinte')
  expect(applyFieldOperation('number', 'subtract', 1, ' 7 ', NOW)).toEqual({ kind: 'value', value: 6 })
  expect(applyFieldOperation('number', 'add', 1, 'vinte', NOW)).toEqual({ kind: 'skip' })
})

it.each([['Pacific/Auckland', '2026-10-26', '2026-11-02'], ['America/Sao_Paulo', '2026-10-25', '2026-11-01']])(
  'data: agora e somar dias usam o dia do fuso do contato (%s)', async (zone, today, week) => {
    await bindings.DB.prepare('UPDATE contacts SET timezone=? WHERE id=?').bind(zone, 'c-a').run()
    await apply([{ type: 'set_custom_field_value', field_id: 'prazo', operation: 'set_now' }])
    expect(await stored('prazo')).toBe(today)
    await bindings.DB.prepare("DELETE FROM contact_field_values WHERE field_id='prazo'").run()
    await apply([{ type: 'set_custom_field_value', field_id: 'prazo', operation: 'add_days', value: 7 }])
    expect(await stored('prazo')).toBe(week)
  })

it('data: sem fuso no contato vale o fuso da conta', async () => {
  vi.setSystemTime(Date.parse('2026-10-25T02:00:00Z'))
  await bindings.DB.prepare("UPDATE contacts SET timezone=NULL WHERE id='c-a'").run()
  await apply([{ type: 'set_custom_field_value', field_id: 'prazo', operation: 'set_now' }])
  expect(await stored('prazo')).toBe('2026-10-24')   // a conta é America/Sao_Paulo (UTC-3)
})

it('publicar recusa operando de somar/subtrair que não é número nem variável; campo arquivado é nomeado', async () => {
  const check = (value: unknown, operation = 'add') => validateActionReference(bindings.DB, 'a',
    actionSchema.parse({ type: 'set_custom_field_value', field_id: 'pontos', operation, value }))
  await expect(check('não é número')).rejects.toThrow(/número/)
  await expect(check('abc', 'subtract')).rejects.toThrow()
  await expect(check('5')).resolves.toBeUndefined()
  await expect(check(2.5)).resolves.toBeUndefined()
  await expect(check(messageVariable('campo:apelido', '1'))).resolves.toBeUndefined()
  await bindings.DB.prepare("UPDATE custom_fields SET archived=1 WHERE id='pontos'").run()
  await expect(check(1)).rejects.toThrow('arquivado')
  await expect(check(1)).rejects.toThrow('Pontos')
})

it('somar com operando inválido ou valor atual inválido não muda o campo e deixa um registro no histórico da conversa', async () => {
  await bindings.DB.prepare("INSERT INTO conversations(id,workspace_id,contact_channel_id) VALUES ('conv-campo','a','cc-a')").run()
  await apply([{ type: 'set_custom_field_value', field_id: 'pontos', operation: 'add', value: 'não é número' }])
  expect(await stored('pontos')).toBeUndefined()
  const events = await bindings.DB.prepare("SELECT content FROM messages WHERE conversation_id='conv-campo' AND json_extract(content,'$.event.kind')='field_skipped'").all<{ content: string }>()
  expect(events.results).toHaveLength(1)
  expect(JSON.parse(events.results[0]!.content).event).toMatchObject({ kind: 'field_skipped', field_id: 'pontos', field_name: 'Pontos', operation: 'add', reason: 'operand' })
})
