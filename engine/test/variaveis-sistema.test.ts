import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { contactVariableRenderer } from '../src/db/message-variables'
import { variableErrors } from '../src/schemas/message-variables'
import { translateVariables } from '../src/flow/manychat-import/vars'
import { seed } from './fixtures'

beforeEach(seed)

it('variáveis de sistema leem o contato e caem no padrão quando vazias', async () => {
  await env.DB.prepare("UPDATE contacts SET first_name='Ana',last_name='Lima',email='ana@oficina.com',phone=NULL,locale='pt_BR' WHERE id='c-a'").run()
  const render = await contactVariableRenderer(env.DB, 'a', 'c-a')
  expect(render('Oi {{nome_completo|}}, {{email|}} · {{idioma|}} · {{telefone|sem telefone}} · {{contato_id|}}')).toBe('Oi Ana Lima, ana@oficina.com · pt_BR · sem telefone · c-a')
  expect(variableErrors('{{email|}} {{ultima_mensagem|}} {{inscrito_em|}}', new Set())).toEqual([])
  expect(variableErrors('{{senha|}}', new Set())).toHaveLength(1)
})

it('importação do ManyChat traduz os campos de sistema', () => {
  const hooks = { field: (id: string) => ({ id }), warn: () => {} }
  expect(translateVariables('{{email}} {{phone|fallback:"-"}} {{full_name}}', hooks)).toBe('{{email|}} {{telefone|-}} {{nome_completo|}}')
})
