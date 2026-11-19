import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) { return next(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { configureDataMode } = await import('./api.ts')
const email = await import('./email.ts')
const previous = globalThis.fetch
afterEach(() => { globalThis.fetch = previous; configureDataMode(undefined) })
test('remetentes e design usam motor e workspace autenticado; teste nunca chama provedor', async () => {
  configureDataMode('real')
  const calls = []
  globalThis.fetch = async (url, init = {}) => { calls.push({url, method: init.method ?? 'GET', body: init.body && JSON.parse(init.body), workspace: init.headers?.get('x-workspace')}); return Response.json(url === '/api/session/workspace' ? {workspace_id:'real',name:'Oficina'} : {ok:true}) }
  await email.getEmailSettings()
  await email.saveEmailSender({address:'equipe@oficina.test',name:'Oficina',replyTo:'ajuda@oficina.test',branding:false})
  await email.saveEmailSender({name:'Equipe'},'sender 1')
  await email.updateEmailSettings({defaultSenderId:'sender 1',company:{name:'Oficina',address:'Rua Central, 10'}})
  await email.verifyEmailSender('sender 1')
  const design = {content:{type:'page',children:[]},subject:'Olá',subTitle:'Novidades'}
  await email.saveEmailDraft({name:'Boas-vindas',senderId:'sender 1',subject:'Olá',preheader:'Novidades',text:'Olá',html:'<p>Olá</p>',design})
  await email.sendEmailTest({senderId:'sender 1',to:'teste@oficina.test',subject:'Olá',preheader:'Novidades',text:'Olá',html:'<p>Olá</p>',design})
  assert.deepEqual(calls.filter(c=>c.url !== '/api/session/workspace').map(c=>[c.url,c.method]), [['/api/email/settings','GET'],['/api/email/senders','POST'],['/api/email/senders/sender%201','PATCH'],['/api/email/settings','PATCH'],['/api/email/senders/sender%201/verify','POST'],['/api/email/drafts','POST'],['/api/email/test','POST']])
  assert.ok(calls.slice(1).every(c=>c.workspace === 'real'))
  assert.deepEqual(calls.at(-2).body.design,design)
})

test('perfil e métricas usam as rotas de e-mail com endereço e consentimento explícitos', async () => {
  configureDataMode('real')
  const calls = []
  globalThis.fetch = async (url, init = {}) => { calls.push({url,method:init.method ?? 'GET',body:init.body && JSON.parse(init.body)});return Response.json(url === '/api/session/workspace' ? {workspace_id:'real',name:'Oficina'} : {ok:true}) }
  await email.getEmailContact('contato 1')
  await email.updateEmailContact('contato 1',{address:'novo@oficina.test',optedIn:true,consent:true})
  await email.updateEmailContact('contato 1',{optedIn:false})
  await email.getEmailMetrics()
  assert.deepEqual(calls.slice(1),[
    {url:'/api/email/contacts/contato%201',method:'GET',body:undefined},
    {url:'/api/email/contacts/contato%201',method:'PATCH',body:{address:'novo@oficina.test',optedIn:true,consent:true}},
    {url:'/api/email/contacts/contato%201',method:'PATCH',body:{optedIn:false}},
    {url:'/api/email/metrics',method:'GET',body:undefined},
  ])
})
