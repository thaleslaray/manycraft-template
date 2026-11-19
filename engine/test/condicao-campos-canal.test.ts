import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { seed, graph } from './fixtures'
import { condition } from '../src/flow/nodes'
import { publishAutomation } from '../src/db/automations'
import { contactVariableRenderer, validateMessageVariables } from '../src/db/message-variables'
import { variableErrors } from '../src/schemas/message-variables'

const run: any = { id: 'run-canal', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', automation_id: 'auto-a' }
const regra = (field: string, operator: string, value?: unknown) => ({ type: 'system_field', field, operator, ...(value === undefined ? {} : { value }) })
const ok = async (field: string, operator: string, value?: unknown) => (await condition(env, run, { match: 'all', rules: [regra(field, operator, value)] })) === 'true'
const campos = (json: string | null) => env.DB.prepare("UPDATE contact_channels SET channel_fields=?,username='ana.lima' WHERE id='cc-a'").bind(json).run()

beforeEach(async () => {
  await seed()
  await campos('{"follows_business":true,"business_follows_contact":false,"verified":false,"follower_count":1520}')
})

it('Instagram: está seguindo sua conta e verificado (booleano é / não é)', async () => {
  expect(await ok('channel_follows_business', 'equals', true)).toBe(true)
  expect(await ok('channel_follows_business', 'equals', false)).toBe(false)
  expect(await ok('channel_follows_business', 'not_equals', true)).toBe(false)
  expect(await ok('channel_follows_business', 'not_equals', false)).toBe(true)
  expect(await ok('channel_verified', 'equals', false)).toBe(true)
  expect(await ok('channel_verified', 'equals', true)).toBe(false)
  await campos('{"follows_business":false}')
  expect(await ok('channel_follows_business', 'equals', true)).toBe(false)
  expect(await ok('channel_follows_business', 'equals', false)).toBe(true)
})

it('Instagram: número de seguidores (=, ≠, >, <) e usuário (é, não é, contém)', async () => {
  expect(await ok('channel_follower_count', 'equals', 1520)).toBe(true)
  expect(await ok('channel_follower_count', 'not_equals', 1520)).toBe(false)
  expect(await ok('channel_follower_count', 'gt', 1000)).toBe(true)
  expect(await ok('channel_follower_count', 'gt', 1520)).toBe(false)
  expect(await ok('channel_follower_count', 'lt', 2000)).toBe(true)
  expect(await ok('channel_follower_count', 'lt', 1520)).toBe(false)
  expect(await ok('channel_username', 'equals', 'ANA.lima')).toBe(true)
  expect(await ok('channel_username', 'equals', '@ana.lima')).toBe(true)
  expect(await ok('channel_username', 'not_equals', 'ana.lima')).toBe(false)
  expect(await ok('channel_username', 'contains', 'lima')).toBe(true)
  expect(await ok('channel_username', 'contains', 'souza')).toBe(false)
})

it('Instagram: dado que o provedor não informou não casa; contato sem Instagram avalia falso', async () => {
  await campos('{"verified":true}')
  expect(await ok('channel_follows_business', 'equals', true)).toBe(false)
  expect(await ok('channel_follows_business', 'not_equals', true)).toBe(false)
  expect(await ok('channel_follows_business', 'is_not_set')).toBe(true)
  expect(await ok('channel_follower_count', 'is_set')).toBe(false)
  // Contato de outro canal, sem esses dados guardados: a regra de perfil avalia falso e não quebra.
  await env.DB.prepare("UPDATE channels SET type='telegram' WHERE id='ch-a'").run()
  await campos(null)
  await env.DB.prepare("UPDATE contact_channels SET username=NULL WHERE id='cc-a'").run()
  for (const [field, operator, value] of [['channel_follows_business', 'equals', true], ['channel_follows_business', 'not_equals', true], ['channel_follower_count', 'gt', 0],
    ['channel_follower_count', 'is_not_set', undefined], ['channel_verified', 'equals', true], ['channel_username', 'not_equals', 'x']] as const)
    expect(await ok(field, operator, value)).toBe(false)
})

it('valor ou operador incompatível com o dado do Instagram é recusado', async () => {
  const tenta = (field: string, operator: string, value?: unknown) => condition(env, run, { match: 'all', rules: [regra(field, operator, value)] })
  await expect(tenta('channel_follows_business', 'gt', 1)).rejects.toThrow()
  await expect(tenta('channel_follows_business', 'equals', 'sim')).rejects.toThrow()
  await expect(tenta('channel_follower_count', 'contains', 'a')).rejects.toThrow()
  await expect(tenta('channel_follower_count', 'gt', '10')).rejects.toThrow()
  await expect(tenta('channel_username', 'gt', 1)).rejects.toThrow()
})

it('direto na Condição: nome, sobrenome, inscrito, gênero e última interação', async () => {
  await env.DB.prepare("UPDATE contacts SET gender='female',last_interaction_at=? WHERE id='c-a'").bind(Date.now() - 2 * 86400000).run()
  expect(await ok('first_name', 'equals', 'mariana')).toBe(true)
  expect(await ok('first_name', 'not_equals', 'Mariana')).toBe(false)
  expect(await ok('first_name', 'contains', 'ari')).toBe(true)
  expect(await ok('last_name', 'equals', 'Oliveira')).toBe(true)
  expect(await ok('last_name', 'not_equals', 'Oliveira')).toBe(false)
  expect(await ok('gender', 'equals', 'female')).toBe(true)
  expect(await ok('gender', 'equals', 'male')).toBe(false)
  expect(await ok('status', 'equals', 'subscribed')).toBe(true)
  expect(await ok('status', 'equals', 'unsubscribed')).toBe(false)
  expect(await ok('last_interaction_at', 'within_days', 3)).toBe(true)
  expect(await ok('last_interaction_at', 'within_days', 1)).toBe(false)
  await env.DB.prepare("UPDATE contacts SET status='unsubscribed' WHERE id='c-a'").run()
  expect(await ok('status', 'equals', 'subscribed')).toBe(false)
  expect(await ok('status', 'equals', 'unsubscribed')).toBe(true)
  await expect(condition(env, run, { match: 'all', rules: [regra('status', 'equals', 'talvez')] })).rejects.toThrow()
})

it('direto na Condição: janela de 24 h aberta/fechada e autorizou (opt-in do canal)', async () => {
  expect(await ok('window_open', 'equals', true)).toBe(false)
  expect(await ok('window_open', 'equals', false)).toBe(true)
  await env.DB.prepare('UPDATE contact_channels SET window_expires_at=? WHERE id=?').bind(Date.now() + 3600000, 'cc-a').run()
  expect(await ok('window_open', 'equals', true)).toBe(true)
  expect(await ok('window_open', 'not_equals', true)).toBe(false)
  await env.DB.prepare('UPDATE contact_channels SET window_expires_at=? WHERE id=?').bind(Date.now() - 3600000, 'cc-a').run()
  expect(await ok('window_open', 'equals', true)).toBe(false)
  expect(await ok('opt_in_instagram', 'equals', true)).toBe(true)
  expect(await ok('opt_in_instagram', 'equals', false)).toBe(false)
  expect(await ok('opt_in_whatsapp', 'equals', true)).toBe(false)
  expect(await ok('opt_in_whatsapp', 'equals', false)).toBe(true)
  await env.DB.prepare('UPDATE contact_channels SET opted_in=0 WHERE id=?').bind('cc-a').run()
  expect(await ok('opt_in_instagram', 'equals', true)).toBe(false)
  expect(await ok('opt_in_instagram', 'not_equals', true)).toBe(true)
})

it('campo do bot na Condição: texto, número e booleano; valor ausente não casa', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO custom_fields (id,workspace_id,scope,name,type,bot_value) VALUES ('bot-n','a','bot','Vagas','number','10'),('bot-t','a','bot','Cupom','text','\"VERAO\"'),('bot-v','a','bot','Vazio','text',NULL),('bot-b','a','bot','Aberto','boolean','true'),('bot-x','b','bot','Outro','text','\"x\"')"),
  ])
  const bot = async (field_id: string, operator: string, value?: unknown) => (await condition(env, run, { match: 'all', rules: [{ type: 'bot_field', field_id, operator, ...(value === undefined ? {} : { value }) }] })) === 'true'
  expect(await bot('bot-n', 'gt', 5)).toBe(true)
  expect(await bot('bot-n', 'lt', 5)).toBe(false)
  expect(await bot('bot-n', 'equals', 10)).toBe(true)
  expect(await bot('bot-t', 'equals', 'verao')).toBe(true)
  expect(await bot('bot-t', 'contains', 'ER')).toBe(true)
  expect(await bot('bot-t', 'not_equals', 'verao')).toBe(false)
  expect(await bot('bot-b', 'equals', true)).toBe(true)
  expect(await bot('bot-v', 'is_not_set')).toBe(true)
  expect(await bot('bot-v', 'is_set')).toBe(false)
  expect(await bot('bot-v', 'equals', 'a')).toBe(false)
  expect(await bot('bot-sumiu', 'equals', 'a')).toBe(false)
  expect(await bot('bot-x', 'equals', 'x')).toBe(false)
  await expect(condition(env, run, { match: 'all', rules: [{ type: 'bot_field', field_id: 'bot-t', operator: 'gt', value: 1 }] })).rejects.toThrow()
})

it('publicação valida os dados novos e o campo do bot', async () => {
  await env.DB.prepare("INSERT INTO custom_fields (id,workspace_id,scope,name,type,bot_value) VALUES ('bot-n','a','bot','Vagas','number','10'),('bot-x','b','bot','Outro','text',NULL)").run()
  const publicar = async (rule: unknown) => {
    const draft = { nodes: [...graph.nodes, { id: 'logic', type: 'condition', position: { x: 0, y: 0 }, config: { match: 'all', rules: [rule] } }], edges: [...graph.edges, { from: 'm', port: 'next', to: 'logic' }] }
    await env.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(JSON.stringify(draft)).run()
    return publishAutomation(env.DB, 'a', 'auto-a')
  }
  await expect(publicar(regra('channel_follows_business', 'equals', true))).resolves.toBeDefined()
  await expect(publicar(regra('first_name', 'contains', 'Ma'))).resolves.toBeDefined()
  await expect(publicar({ type: 'bot_field', field_id: 'bot-n', operator: 'gt', value: 3 })).resolves.toBeDefined()
  await expect(publicar(regra('channel_follows_business', 'gt', 3))).rejects.toThrow()
  await expect(publicar({ type: 'bot_field', field_id: 'bot-x', operator: 'equals', value: 'x' })).rejects.toThrow()
  await expect(publicar({ type: 'bot_field', field_id: 'field-a', operator: 'equals', value: 'x' })).rejects.toThrow()
})

it('variáveis do Instagram: usuário, seguidores, segue a conta e verificado', async () => {
  const render = await contactVariableRenderer(env.DB, 'a', 'c-a')
  expect(render('@{{canal_usuario|}} · {{canal_seguidores|0}} · {{canal_segue_conta|?}} · {{canal_verificado|?}}')).toBe('@ana.lima · 1520 · sim · não')
  await env.DB.prepare("UPDATE channels SET type='telegram' WHERE id='ch-a'").run()
  await campos(null)
  await env.DB.prepare("UPDATE contact_channels SET username=NULL WHERE id='cc-a'").run()
  const sem = await contactVariableRenderer(env.DB, 'a', 'c-a')
  expect(sem('{{canal_usuario|sem}} {{canal_seguidores|0}} {{canal_segue_conta|?}}')).toBe('sem 0 ?')
  expect(variableErrors('{{canal_usuario|}} {{canal_seguidores|}} {{canal_segue_conta|}} {{canal_verificado|}}', new Set())).toEqual([])
  await expect(validateMessageVariables(env.DB, 'a', ['{{canal_usuario|}}'])).resolves.toBeUndefined()
})
