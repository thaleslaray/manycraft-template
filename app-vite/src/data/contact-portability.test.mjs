import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) { return next(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { configureDataMode } = await import('./api.ts')
const data = await import('./contact-portability.ts')
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; configureDataMode(undefined) })
test('portabilidade usa contexto autenticado, confirmações e IDs codificados', async () => {
  configureDataMode('real')
  const calls = []
  globalThis.fetch = async (url, init) => {
    if (url === '/api/session/workspace') return Response.json({workspace_id:'real',name:'Teste'})
    assert.equal(init.headers.get('x-workspace'), 'real')
    calls.push({url,method:init.method,body:init.body && JSON.parse(init.body)})
    return Response.json({ count: 1 })
  }
  await data.bulkContactAction('pause', ['a'], 'PAUSAR')
  await data.bulkContactAction('unsubscribe', ['a'], 'DESCADASTRAR')
  await data.exportContact('a/b')
  await data.previewContactMerge('a', 'b')
  await data.mergeContacts('a', 'b', 'MESCLAR')
  assert.deepEqual(calls, [
    {url:'/api/contacts/bulk-pause',method:'POST',body:{ids:['a'],confirmation:'PAUSAR'}},
    {url:'/api/contacts/bulk-unsubscribe',method:'POST',body:{ids:['a'],confirmation:'DESCADASTRAR'}},
    {url:'/api/contacts/a%2Fb/export',method:undefined,body:undefined},
    {url:'/api/contacts/merge-preview',method:'POST',body:{primary_id:'a',secondary_id:'b'}},
    {url:'/api/contacts/merge',method:'POST',body:{primary_id:'a',secondary_id:'b',confirmation:'MESCLAR'}},
  ])
})
