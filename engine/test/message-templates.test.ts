import { env } from 'cloudflare:workers'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

const input = { name: 'pedido_confirmado', category: 'utility', language: 'pt_BR', header: { type: 'none' }, body: 'Olá {{1}}, seu pedido está confirmado.', examples: { '1': 'Nara' }, footer: 'Oficina Horizonte', buttons: [] }
const request = (path: string, method = 'GET', body?: unknown, ws = 'a') => authenticatedRequest(`message-templates/${path}`, ws, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
beforeEach(async () => {
  await seedAuth()
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,settings) VALUES ('wa-a','a','whatsapp','meta_whatsapp_cloud','123','{\"wabaId\":\"456\"}')").run()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Rede real proibida no teste') })
})
afterEach(() => vi.restoreAllMocks())
it('cria rascunho persistente por conexão, sem enviar ao provedor', async () => {
  const response = await request('wa-a', 'POST', input)
  expect(response.status).toBe(201)
  const created = await response.json() as { id: string }
  expect(await (await request('wa-a')).json()).toEqual([expect.objectContaining({ id: created.id, ...input, status: 'draft', quality: 'unknown' })])
  expect(fetch).not.toHaveBeenCalled()
})
it.each([
  { body:'Olá {{constructor}}, pedido recebido.',examples:{} }, { body:'Olá {{nome}}, pedido recebido.',examples:{nome:'Nara'},header:{type:'text',text:'Pedido {{1}}',example:'123'} },
  { name: 'Nome Inválido' }, { name: 'a'.repeat(513) }, { body: '' }, { body: 'a'.repeat(1025) }, { body: 'Oi\tcliente' }, { body: 'Oi\n\n\ncliente' },
  { body: '{{1}} seja bem-vinda.' }, { body: 'Olá, {{1}}' }, { body: 'Olá {{2}}, seu pedido chegou.', examples: { '2': 'Nara' } }, { body: 'Olá {{#1}}, seu pedido chegou.' },
  { body: 'Olá {{1}, seu pedido chegou.' }, { examples: {} }, { examples: { '1': '' } },
  { header: { type: 'text', text: 'a'.repeat(61) } }, { header: { type: 'text', text: 'Oi\ncliente' } }, { header: { type: 'text', text: 'Oi *cliente*' } },
  { footer: 'a'.repeat(61) }, { footer: '{{1}}' }, { language: 'xx_FAKE' },
  { buttons: [{ type: 'url', text: 'Abrir', url: 'javascript:alert(1)' }] }, { buttons: [{ type: 'url', text: 'Abrir', url: 'https://wa.me/5511' }] },
  { buttons: [{ type: 'reply', text: 'Sim' }, { type: 'url', text: 'Abrir', url: 'https://example.test' }, { type: 'reply', text: 'Não' }] },
  { buttons: [{ type: 'reply', text: 'Sim' }, { type: 'reply', text: 'Sim' }] }, { buttons: [{ type: 'reply', text: 'a'.repeat(26) }] },
  { buttons: Array.from({ length: 11 }, (_,i) => ({ type: 'reply', text: `Resposta ${i}` })) },
  { header: { type: 'image', mediaUrl: 'bad' } },
])('recusa rascunho inválido: %j', async change => {
  expect((await request('wa-a','POST',{ ...input, ...change })).status).toBe(400)
  expect(fetch).not.toHaveBeenCalled()
})
it('ficha efetiva, isolamento e permissões valem em todas as operações', async () => {
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id) VALUES ('uz-a','a','whatsapp','uazapi','fake')").run()
  expect(await (await request('options')).json()).toMatchObject({ connections: [{ id: 'wa-a' }], canEdit: true })
  expect((await request('uz-a','POST',input)).status).toBe(409)
  expect((await request('wa-a','POST',input,'b')).status).toBe(404)
  await env.DB.prepare("UPDATE channels SET capabilities_override='{\"remove\":[\"templates\"]}' WHERE id='wa-a'").run()
  expect((await request('wa-a','POST',input)).status).toBe(409)
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id='user-a'").run()
  expect((await request('wa-a','POST',input)).status).toBe(403)
})
it('envia à revisão uma vez, trava edição, sincroniza status/qualidade e oferece aprovado na transmissão', async () => {
  const { giveCredentials } = await import('./credentials')
  await giveCredentials(env,'wa-a',{ accessToken:'TESTONLY',phoneNumberId:'123',wabaId:'456' })
  const calls: { path: string; body: unknown }[] = []
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    calls.push({ path: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
    return init?.method === 'POST' ? Response.json({ id:'provider-1',status:'PENDING',category:'UTILITY' })
      : Response.json({ data:[{ id:'provider-1',name:input.name,language:'pt_BR',status:'APPROVED',category:'MARKETING',quality_score:{ score:'GREEN' } }] })
  })
  const created = await (await request('wa-a','POST',input)).json() as { id: string }
  const path = `wa-a/${created.id}`
  expect((await request(path,'PATCH', { ...input, footer:'Confirmação da oficina' })).status).toBe(200)
  expect((await request(`${path}/submit`,'POST')).status).toBe(200)
  expect(calls).toEqual([{ path:'https://graph.facebook.com/v26.0/456/message_templates',body:{ name:input.name,language:'pt_BR',category:'UTILITY',parameter_format:'POSITIONAL',components:[{type:'BODY',text:input.body,example:{body_text:[['Nara']]}},{type:'FOOTER',text:'Confirmação da oficina'}] } }])
  expect((await request(path,'PATCH',input)).status).toBe(409)
  expect((await request(`${path}/submit`,'POST')).status).toBe(409)
  expect((await request('wa-a/sync','POST')).status).toBe(200)
  expect(await (await request('wa-a')).json()).toEqual([expect.objectContaining({ id:created.id,status:'approved',quality:'green',category:'marketing' })])
  const options = await authenticatedRequest('broadcasts/options')
  expect(await options.json()).toMatchObject({ templates:[expect.objectContaining({ id:created.id,name:input.name })] })
  // O mesmo status remoto nunca transforma rascunho local em modelo aprovado.
  const second = await (await request('wa-a','POST',{...input,name:'outro_modelo'})).json() as {id:string}
  expect((await request('wa-a/sync','POST')).status).toBe(200)
  expect(await (await request('wa-a')).json()).toContainEqual(expect.objectContaining({id:second.id,status:'draft'}))
})
it('resultado incerto mantém edição travada e não repete submissão', async () => {
  const { giveCredentials } = await import('./credentials')
  await giveCredentials(env,'wa-a',{accessToken:'TESTONLY',phoneNumberId:'123',wabaId:'456'})
  const created = await (await request('wa-a','POST',input)).json() as {id:string}
  expect((await request(`wa-a/${created.id}/submit`,'POST')).status).toBe(503)
  expect((await request(`wa-a/${created.id}/submit`,'POST')).status).toBe(409)
  expect(await (await request('wa-a')).json()).toContainEqual(expect.objectContaining({status:'uncertain'}))
})
it('variável nomeada só no cabeçalho usa o formato nomeado', async () => {
  const { giveCredentials }=await import('./credentials')
  await giveCredentials(env,'wa-a',{accessToken:'TESTONLY',phoneNumberId:'123',wabaId:'456'})
  vi.mocked(fetch).mockResolvedValue(Response.json({id:'remote-named',status:'PENDING',category:'UTILITY'}))
  const d={...input,body:'Seu pedido está confirmado.',examples:{},header:{type:'text',text:'Olá {{nome}}',example:'Nara'}}
  const created=await (await request('wa-a','POST',d)).json() as {id:string}
  expect((await request(`wa-a/${created.id}/submit`,'POST')).status).toBe(200)
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({parameter_format:'NAMED',components:[{type:'HEADER',format:'TEXT',example:{header_text_named_params:[{param_name:'nome',example:'Nara'}]}},{type:'BODY',text:d.body},{type:'FOOTER',text:input.footer}]})
})
it.each(['lost','pending'])('sincronização confirmada durante uma submissão %s não reabre nem regride o modelo', async outcome => {
  const { giveCredentials }=await import('./credentials')
  await giveCredentials(env,'wa-a',{accessToken:'TESTONLY',phoneNumberId:'123',wabaId:'456'})
  vi.mocked(fetch).mockImplementation(async (_url,init)=>{
    if(init?.method==='POST'){
      expect((await request('wa-a/sync','POST')).status).toBe(200)
      if(outcome==='lost')throw new Error('Resposta de criação perdida')
      return Response.json({id:'remote-race',status:'PENDING',category:'UTILITY'})
    }
    return Response.json({data:[{id:'remote-race',name:input.name,language:input.language,status:'APPROVED',category:'UTILITY',quality_score:{score:'GREEN'}}]})
  })
  const created=await (await request('wa-a','POST',input)).json() as {id:string}
  await request(`wa-a/${created.id}/submit`,'POST')
  expect(await (await request('wa-a')).json()).toContainEqual(expect.objectContaining({status:'approved',quality:'green'}))
  expect((await request(`wa-a/${created.id}`,'PATCH',input)).status).toBe(409)
})

// Formatos conforme a documentação da Graph API (GET /{waba}/message_templates com components).
const remoteOnly = [
  { id:'900', name:'boas_vindas', language:'pt_BR', status:'APPROVED', category:'MARKETING', parameter_format:'POSITIONAL', quality_score:{score:'GREEN'},
    components:[{type:'HEADER',format:'TEXT',text:'Oi {{1}}',example:{header_text:['Nara']}},{type:'BODY',text:'Olá {{1}}, bem-vinda à {{2}}.',example:{body_text:[['Nara','Oficina']]}},
      {type:'FOOTER',text:'Oficina Horizonte'},{type:'BUTTONS',buttons:[{type:'QUICK_REPLY',text:'Quero'},{type:'PHONE_NUMBER',text:'Ligar',phone_number:'+5511999990000'}]}] },
  { id:'901', name:'aviso_simples', language:'pt_BR', status:'APPROVED', category:'UTILITY', components:[{type:'BODY',text:'Seu pedido saiu para entrega.'}] },
  { id:'902', name:'em_analise', language:'pt_BR', status:'IN_APPEAL', category:'UTILITY', components:[{type:'BODY',text:'Texto em apelação.'}] },
  { id:'903', name:'apagado', language:'pt_BR', status:'DELETED', category:'UTILITY', components:[{type:'BODY',text:'Já apagado na Meta.'}] },
  { id:'904', name:'nomeado', language:'en_US', status:'PAUSED', category:'UTILITY', parameter_format:'NAMED', components:[{type:'BODY',text:'Hi {{first_name}}.',example:{body_text_named_params:[{param_name:'first_name',example:'Nara'}]}}] },
]
it('sincronizar traz modelos que só existem na Meta, uma única vez, com conteúdo utilizável', async () => {
  const { giveCredentials } = await import('./credentials')
  await giveCredentials(env,'wa-a',{ accessToken:'TESTONLY',phoneNumberId:'123',wabaId:'456' })
  vi.mocked(fetch).mockImplementation(async url => {
    expect(new URL(String(url)).searchParams.get('fields')).toContain('components')
    return Response.json({ data: remoteOnly })
  })
  expect(await (await request('wa-a/sync','POST')).json()).toMatchObject({ imported: 4 })
  expect((await request('wa-a/sync','POST')).status).toBe(200)
  const list = await (await request('wa-a')).json() as { name:string; status:string; body:string; examples:object; header:object; buttons:object[]; footer:string; category:string; quality:string }[]
  expect(list).toHaveLength(4)
  expect(list).toContainEqual(expect.objectContaining({ name:'boas_vindas', status:'approved', category:'marketing', quality:'green', body:'Olá {{1}}, bem-vinda à {{2}}.',
    examples:{'1':'Nara','2':'Oficina'}, header:{type:'text',text:'Oi {{1}}',example:'Nara'}, footer:'Oficina Horizonte', buttons:[{type:'reply',text:'Quero'}] }))
  expect(list).toContainEqual(expect.objectContaining({ name:'nomeado', status:'paused', examples:{first_name:'Nara'} }))
  expect(list).toContainEqual(expect.objectContaining({ name:'em_analise', status:'pending' }))
  expect(list.map(t => t.name)).not.toContain('apagado')
  const options = await (await authenticatedRequest('broadcasts/options')).json() as { templates:{name:string}[] }
  expect(options.templates.map(t => t.name).sort()).toEqual(['aviso_simples','boas_vindas'])
})
it('trocar a conta: modelo que sumiu fica indisponível, o de mesmo nome adota o id novo, e volta a valer se reaparecer', async () => {
  const { giveCredentials } = await import('./credentials')
  await giveCredentials(env,'wa-a',{ accessToken:'TESTONLY',phoneNumberId:'123',wabaId:'456' })
  let data: unknown[] = remoteOnly
  vi.mocked(fetch).mockImplementation(async () => Response.json({ data }))
  expect(await (await request('wa-a/sync','POST')).json()).toMatchObject({ imported: 4 })
  // Conta nova: só existe boas_vindas, com outro id.
  data = [{ ...(remoteOnly as { name:string }[]).find(r => r.name === 'boas_vindas'), id:'novo-1' }]
  expect(await (await request('wa-a/sync','POST')).json()).toMatchObject({ imported: 0, skipped: 0 })
  type Row = { name:string; status:string; unavailableReason:string|null }
  let list = await (await request('wa-a')).json() as Row[]
  expect(list).toHaveLength(4)
  expect(list.find(t => t.name === 'boas_vindas')).toMatchObject({ status:'approved', unavailableReason:null })
  expect(list.find(t => t.name === 'aviso_simples')?.unavailableReason).toMatch(/não existe na conta/)
  expect((await env.DB.prepare("SELECT provider_id p FROM message_templates WHERE channel_id='wa-a' AND name_human='boas_vindas'").first<{p:string}>())?.p).toBe('novo-1')
  const options = await (await authenticatedRequest('broadcasts/options')).json() as { templates:{name:string}[] }
  expect(options.templates.map(t => t.name)).toEqual(['boas_vindas'])
  // Lista vazia da Meta não marca nada além do que já sumiu; reaparecendo, o modelo volta.
  data = remoteOnly
  expect((await request('wa-a/sync','POST')).status).toBe(200)
  list = await (await request('wa-a')).json() as Row[]
  expect(list.find(t => t.name === 'aviso_simples')?.unavailableReason).toBeNull()
})
it('um modelo remoto ilegível não derruba a sincronização dos demais', async () => {
  const { giveCredentials } = await import('./credentials')
  await giveCredentials(env,'wa-a',{ accessToken:'TESTONLY',phoneNumberId:'123',wabaId:'456' })
  vi.mocked(fetch).mockResolvedValue(Response.json({ data:[{ id:'1', name:'x', status:'ALGO_NOVO' }, { id:'901', name:'aviso_simples', language:'pt_BR', status:'APPROVED', category:'UTILITY', components:[{type:'BODY',text:'Oi.'}] }] }))
  expect((await request('wa-a/sync','POST')).status).toBe(200)
  expect(await (await request('wa-a')).json()).toEqual([expect.objectContaining({ name:'aviso_simples' })])
})
it('analytics do modelo: transmissões que o usaram, enviados, falhas e cliques', async () => {
  const { id } = await (await request('wa-a', 'POST', input)).json() as { id: string }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO broadcasts(id,workspace_id,name,channel_id,template) VALUES ('bt','a','Promo','wa-a',?)").bind(JSON.stringify({ id, params: {} })),
    env.DB.prepare("INSERT INTO contacts(id,workspace_id) VALUES ('k1','a'),('k2','a')"),
    env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,opted_in) VALUES ('cc1','a','k1','wa-a','BR.um','bsuid',1),('cc2','a','k2','wa-a','BR.dois','bsuid',1)"),
    env.DB.prepare("INSERT INTO broadcast_recipients(workspace_id,broadcast_id,contact_channel_id,run_id,status,updated_at) VALUES ('a','bt','cc1','r1','sent',1),('a','bt','cc2','r2','failed',1)"),
    env.DB.prepare(`INSERT INTO broadcast_links(token,workspace_id,broadcast_id,contact_channel_id,button_id,target_url,clicked_at) VALUES ('${'a'.repeat(32)}','a','bt','cc1','b','https://x.test',5)`),
  ])
  const { items } = await (await request('wa-a/analytics')).json() as { items: Record<string, unknown>[] }
  expect(items).toEqual([expect.objectContaining({ id, broadcasts: 1, sent: 1, failed: 1, skipped: 0, clicked: 1, click_rate: 1 })])
})
