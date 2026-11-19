import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareTemplateMessage } from '../src/inbox/template-message'
import { metaWhatsappCloud } from '../src/channels/meta-whatsapp-cloud'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import type { Connection } from '../src/channels/contract'
import { seed } from './fixtures'

beforeEach(async () => {
  await seed()
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id) VALUES ('wa-a','a','whatsapp','meta_whatsapp_cloud','123'),('wa-other','a','whatsapp','meta_whatsapp_cloud','456')").run()
  await env.DB.prepare(`INSERT INTO message_templates(id,workspace_id,channel_id,group_id,name_human,language_code,status,header_type,header_text,body,footer,buttons)
    VALUES ('approved','a','wa-a','approved','pedido_confirmado','pt_BR','approved','text','Olá {{nome}}','Pedido {{pedido}} confirmado.','Equipe Horizonte',?)`)
    .bind(JSON.stringify([{type:'url',text:'Abrir pedido',url:'https://example.test/pedidos/{{codigo}}'}])).run()
  vi.spyOn(globalThis,'fetch').mockImplementation(async () => { throw new Error('Rede real proibida') })
})
afterEach(() => vi.restoreAllMocks())

it('prepara somente aprovado da conexão e workspace pedidos, sem rede', async () => {
  const result = await prepareTemplateMessage(env,'a','wa-a',{id:'approved',params:{'header:nome':'Nara',pedido:'42','button:0:codigo':'abc'}})
  expect(result.message).toEqual({kind:'template',templateId:'pedido_confirmado',category:'utility',params:{language_code:'pt_BR',pedido:'42'},components:[
    {type:'header',parameters:[{type:'text',text:'Nara',parameter_name:'nome'}]},
    {type:'button',sub_type:'url',index:'0',parameters:[{type:'text',text:'abc'}]},
  ]})
  expect(result.text).toBe('Olá Nara\nPedido 42 confirmado.\nEquipe Horizonte\nAbrir pedido: https://example.test/pedidos/abc')
  for (const [ws,connection] of [['b','wa-a'],['a','wa-other']]) {
    await expect(prepareTemplateMessage(env,ws,connection,{id:'approved',params:{}})).rejects.toMatchObject({status:404})
  }
  await env.DB.prepare("UPDATE message_templates SET status='draft' WHERE id='approved'").run()
  await expect(prepareTemplateMessage(env,'a','wa-a',{id:'approved',params:{}})).rejects.toMatchObject({status:404})
  expect(fetch).not.toHaveBeenCalled()
})

const invalidParams: Record<string,string>[] = [
  {'header:nome':'Nara',pedido:'42'}, {'header:nome':' ',pedido:'42','button:0:codigo':'abc'}, {'header:nome':'Nara',pedido:'42','button:0:codigo':'abc',extra:'forjado'},
  {'header:nome':'Nara',pedido:'42','button:0:codigo':'a'.repeat(1025)},
  {'header:nome':'Nara',pedido:'42','button:0:codigo':'abc',language_code:'en_US'},
]
it.each(invalidParams)('recusa variável ausente, vazia, extra ou longa: %j', async params => {
  await expect(prepareTemplateMessage(env,'a','wa-a',{id:'approved',params})).rejects.toMatchObject({status:400})
  expect(fetch).not.toHaveBeenCalled()
})

it('separa posições iguais de cabeçalho, corpo e botão',async()=>{
  await env.DB.prepare("UPDATE message_templates SET header_text='Pedido {{1}}',body='Olá {{1}}, pedido confirmado.',buttons=? WHERE id='approved'")
    .bind(JSON.stringify([{type:'url',text:'Abrir',url:'https://example.test/{{1}}'}])).run()
  expect((await prepareTemplateMessage(env,'a','wa-a',{id:'approved',params:{'header:1':'42','1':'Nara','button:0:1':'codigo'}})).message).toMatchObject({
    params:{language_code:'pt_BR','1':'Nara'},components:[
      {type:'header',parameters:[{type:'text',text:'42'}]},
      {type:'button',sub_type:'url',index:'0',parameters:[{type:'text',text:'codigo'}]},
    ],
  })
})

it.each(['image','video','document'] as const)('preserva cabeçalho aprovado de %s e parâmetros numéricos no corpo',async media=>{
  await env.DB.prepare("UPDATE message_templates SET header_type=?,header_media_url='https://example.test/media',body='Olá {{1}}, pedido confirmado.',buttons='[]' WHERE id='approved'").bind(media).run()
  expect((await prepareTemplateMessage(env,'a','wa-a',{id:'approved',params:{'1':'Nara'}})).message).toEqual({kind:'template',templateId:'pedido_confirmado',category:'utility',params:{language_code:'pt_BR','1':'Nara'},components:[
    {type:'header',parameters:[{type:media,[media]:{link:'https://example.test/media'}}]},
  ]})
})

it('adaptador transporta cabeçalho, corpo e botão no fake local configurado',async()=>{
  const {message}=await prepareTemplateMessage(env,'a','wa-a',{id:'approved',params:{'header:nome':'Nara',pedido:'42','button:0:codigo':'abc'}})
  const connection:Connection={id:'wa-a',workspaceId:'a',kind:'whatsapp',provider:'meta_whatsapp_cloud',externalId:'123',displayName:null,status:'connected',settings:{apiBase:'http://127.0.0.1:6123'},profile:effectiveProfile('whatsapp','meta_whatsapp_cloud')}
  const fake=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>Response.json({messaging_product:'whatsapp',messages:[{id:'fake.sent'}]}))
  expect(metaWhatsappCloud.fit(message,connection.profile)).toHaveProperty('messages')
  expect(await metaWhatsappCloud.send({connection,credentials:{accessToken:'TESTONLY',phoneNumberId:'123'},target:{kind:'direct',externalUserId:'BR.test'},fetch:fake},message)).toMatchObject({ok:true,externalId:'fake.sent'})
  expect(fake.mock.calls[0][0]).toBe('http://127.0.0.1:6123/v26.0/123/messages')
  expect(JSON.parse(String(fake.mock.calls[0][1]?.body)).template).toEqual({name:'pedido_confirmado',language:{code:'pt_BR'},components:[
    {type:'header',parameters:[{type:'text',text:'Nara',parameter_name:'nome'}]},
    {type:'body',parameters:[{type:'text',text:'42',parameter_name:'pedido'}]},
    {type:'button',sub_type:'url',index:'0',parameters:[{type:'text',text:'abc'}]},
  ]})
  expect(fetch).not.toHaveBeenCalled()
})
