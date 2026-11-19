import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { configureDataMode } = await import('./api.ts')
const rules = await import('./rules.ts')
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; configureDataMode(undefined) })

test('rascunho e publicação usam rotas distintas e o workspace autenticado', async () => {
  configureDataMode('real')
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', workspace: init.headers?.get?.('x-workspace'), body: init.body ? JSON.parse(init.body) : undefined })
    return Response.json(url === '/api/session/workspace' ? { workspace_id: 'real', name: 'Oficina' } : url === '/api/rules' && !init.method ? [] : { id: 'r1' })
  }
  const input = { name: 'Leads', trigger: { type: 'tag_added' }, event_filter: { tag_id: 'lead' }, condition: { match: 'all', groups: [] }, actions: [{ type: 'add_to_sequence', sequence_id: 'serie' }], frequency: 'always' }
  assert.deepEqual(await rules.listRules(), [])
  await rules.saveRule(input)
  await rules.saveRule(input, 'r1')
  await rules.publishRule('r1')
  await rules.setRuleActive('r1', false)
  await rules.duplicateRule('r1')
  await rules.deleteRule('r1')
  assert.deepEqual(calls.slice(2).map(({url,method,body}) => ({url,method,body})), [
    { url: '/api/rules', method: 'POST', body: input },
    { url: '/api/rules/r1', method: 'PUT', body: input },
    { url: '/api/rules/r1/publish', method: 'POST', body: undefined },
    { url: '/api/rules/r1', method: 'PATCH', body: { active: false } },
    { url: '/api/rules/r1/duplicate', method: 'POST', body: undefined },
    { url: '/api/rules/r1', method: 'DELETE', body: undefined },
  ])
  assert.ok(calls.slice(1).every(c => c.workspace === 'real'))
})

test('o que falta na regra é dito pelo campo, antes de ir ao servidor', () => {
  const base = { name: 'Leads', trigger: { type: 'tag_added' }, actions: [{ type: 'add_tag', tag_id: 't1' }], frequency: 'always' }
  assert.equal(rules.ruleProblem(base), null)
  assert.equal(rules.ruleProblem({ ...base, name: ' ' }), 'Dê um nome à regra.')
  assert.equal(rules.ruleProblem({ ...base, trigger: { type: '' } }), 'Escolha um gatilho para salvar a regra.')
  assert.equal(rules.ruleProblem({ ...base, trigger: { type: 'date' } }), 'Escolha um campo de data.')
  assert.equal(rules.ruleProblem({ ...base, actions: [] }), 'Adicione ao menos uma ação.')
  assert.equal(rules.ruleProblem({ ...base, actions: [{ type: 'add_tag', tag_id: '' }] }), 'Ação 1 (Aplicar tag): escolha a tag.')
  assert.equal(rules.ruleProblem({ ...base, actions: [base.actions[0], { type: 'add_to_sequence', sequence_id: '' }] }), 'Ação 2 (Inscrever em sequência): escolha a sequência.')
  assert.equal(rules.ruleProblem({ ...base, actions: [{ type: 'start_automation', automation_id: '' }] }), 'Ação 1 (Iniciar automação): escolha a automação.')
  assert.equal(rules.ruleProblem({ ...base, actions: [{ type: 'set_custom_field_value', field_id: '', value: 1 }] }), 'Ação 1 (Definir campo): escolha o campo.')
  assert.equal(rules.ruleProblem({ ...base, actions: [{ type: 'set_custom_field_value', field_id: 'f1' }] }), 'Ação 1 (Definir campo): informe o valor.')
})
