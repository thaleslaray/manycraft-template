import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { seed, graph } from './fixtures'
import { actions } from '../src/flow/nodes'
import { publishAutomation } from '../src/db/automations'
import { contactVariableRenderer, validateMessageVariables } from '../src/db/message-variables'
import type { FlowEnv, Run } from '../src/flow/types'

const bindings = env as unknown as FlowEnv
const run = { id: 'bot-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', automation_id: 'auto-a' } as Run
const botValue = async () => bindings.DB.prepare("SELECT bot_value FROM custom_fields WHERE id='bot-n'").first('bot_value')

beforeEach(async () => {
  await seed()
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('bot-version','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    bindings.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,channel_id,automation_version_id) VALUES ('bot-run','a','c-a','ch-a','bot-version')"),
    bindings.DB.prepare("INSERT INTO custom_fields (id,workspace_id,scope,name,type,bot_value) VALUES ('bot-n','a','bot','Vagas','number','10'),('bot-t','a','bot','Cupom','text',NULL),('bot-b','b','bot','Outro','text',NULL)"),
  ])
})

it('ação grava e limpa o campo do bot uma vez por passo, e a variável {{bot:ID}} lê o valor global', async () => {
  await actions(bindings, run, { actions: [{ type: 'change_global_field_value', field_id: 'bot-n', value: 7 }, { type: 'change_global_field_value', field_id: 'bot-t', value: 'OI-{{primeiro_nome|}}' }] }, 1)
  expect(await botValue()).toBe('7')
  const render = await contactVariableRenderer(bindings.DB, 'a', 'c-a')
  expect(render('Restam {{bot:bot-n|0}} · {{bot:bot-t|}} · {{bot:sumiu|nada}}')).toBe('Restam 7 · OI-Mariana · nada')
  await actions(bindings, run, { actions: [{ type: 'change_global_field_value', field_id: 'bot-n', value: 1 }] }, 1)
  expect(await botValue()).toBe('7')
  await actions(bindings, run, { actions: [{ type: 'change_global_field_value', field_id: 'bot-n', value: null }] }, 2)
  expect(await botValue()).toBeNull()
  await expect(validateMessageVariables(bindings.DB, 'a', ['{{bot:bot-n|0}}'])).resolves.toBeUndefined()
  await expect(validateMessageVariables(bindings.DB, 'a', ['{{bot:bot-b|0}}'])).rejects.toThrow()
})

it('publicação recusa campo do bot de outro espaço, campo de contato e valor de tipo errado', async () => {
  const publish = async (action: unknown) => {
    await bindings.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(JSON.stringify({ nodes: [graph.nodes[0], { id: 'act', type: 'action', position: { x: 0, y: 0 }, config: { actions: [action] } }], edges: [{ from: 't', port: 'next', to: 'act' }] })).run()
    return publishAutomation(bindings.DB, 'a', 'auto-a')
  }
  await expect(publish({ type: 'change_global_field_value', field_id: 'bot-n', value: 3 })).resolves.toMatchObject({ automation_id: 'auto-a' })
  for (const bad of [{ type: 'change_global_field_value', field_id: 'bot-b', value: 'x' }, { type: 'change_global_field_value', field_id: 'field-a', value: 'x' },
    { type: 'change_global_field_value', field_id: 'bot-n', value: 'muitas' }]) await expect(publish(bad)).rejects.toThrow()
})

it('campo do bot como contador global soma e subtrai no banco', async () => {
  await actions(bindings, run, { actions: [{ type: 'change_global_field_value', field_id: 'bot-n', operation: 'add', value: 5 }] }, 1)
  await actions(bindings, run, { actions: [{ type: 'change_global_field_value', field_id: 'bot-n', operation: 'subtract', value: 2 }] }, 2)
  expect(Number(await botValue())).toBe(13)
  await bindings.DB.prepare("UPDATE custom_fields SET bot_value=NULL WHERE id='bot-n'").run()
  await actions(bindings, run, { actions: [{ type: 'change_global_field_value', field_id: 'bot-n', operation: 'add', value: 1 }] }, 3)
  expect(Number(await botValue())).toBe(1)
})

it('ação de campo de contato excluído depois da publicação é ignorada sem falhar o passo', async () => {
  await actions(bindings, run, { actions: [{ type: 'set_custom_field_value', field_id: 'sumiu', value: 'x' }, { type: 'change_global_field_value', field_id: 'bot-n', value: 2 }] }, 1)
  expect(await botValue()).toBe('2')
})
