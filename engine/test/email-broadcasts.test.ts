import { env as runtime } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { seedAuth, authenticatedRequest } from './auth-helpers'
import { emailConnection, emailContact, initialize } from '../src/email-channel/store'
import { processBroadcastBatch, saveBroadcast, getBroadcast, broadcastOptions, estimateBroadcastAudience, testBroadcast } from '../src/db/broadcasts'
import type { Env } from '../src/env'

beforeEach(async () => {
  await seedAuth()
})
it('transmissão guarda conteúdo e-mail, envia snapshot pelo transporte falso e agrega recibos/cliques por campanha', async () => {
  const env = { ...runtime, APP_ENV:'development', CHANNEL_LIMITER:undefined, INBOUND:{send:vi.fn(async()=>{})} as unknown as Queue } as Env
  await initialize(env,'a')
  await env.DB.prepare("UPDATE email_settings SET company_name='Empresa de estudo',company_address='Rua A, 123' WHERE workspace_id='a'").run()
  const connection = await emailConnection(env,'a')
  const contactId = await emailContact(env,'a',connection,'cliente@exemplo.test',true)
  const owner = {workspaceId:'a',userId:'user-a',role:'owner' as const}
  const options = await broadcastOptions(env,owner)
  expect(options.channels.find(row=>row.id===connection)).toHaveProperty('profile.email')
  const email = {senderId:'email-default-a',subject:'Seu pedido',preheader:'Veja os detalhes',html:'<p>Confira</p><a href="https://exemplo.test/pedido">Pedido</a>'}
  const b = await saveBroadcast(env,owner,{name:'Aviso',content:'Confira',email,status:'sending',audience:{channel:'email',channel_id:connection,tag:'all'}})
  expect(b).toMatchObject({email})
  await processBroadcastBatch(env,'a',b.id)
  const mail = await env.DB.prepare('SELECT id,subject,html,token FROM email_messages WHERE workspace_id=? AND contact_id=?').bind('a',contactId).first<{id:string;subject:string;html:string;token:string}>()
  expect(mail?.subject).toBe(email.subject)
  expect(mail?.html).toContain('/api/email-public/click/')
  const { emailEvent } = await import('../src/email-channel/service')
  const stored = await env.DB.prepare('SELECT * FROM email_messages WHERE id=?').bind(mail!.id).first<any>()
  await emailEvent(env,stored,'opened')
  await emailEvent(env,stored,'opened')
  await emailEvent(env,stored,'clicked','https://exemplo.test/pedido')
  await emailEvent(env,stored,'clicked','https://exemplo.test/pedido')
  await emailEvent(env,stored,'delivered')
  expect(await getBroadcast(env,owner,b.id)).toMatchObject({status:'sent',metrics:{sent:1,delivered:1,opened:1,clicked:1,ctr:1}})
  await env.DB.prepare("INSERT INTO segments(id,workspace_id,name,filter) VALUES ('email-clicou','a','Clicou',?)").bind(JSON.stringify({match:'all',rules:[{type:'email',filter:'opened_clicked'},{type:'system_field',field:'email_opens',operator:'gte',value:2}]})).run()
  const audience={channel:'email' as const,channel_id:connection,tag:'all',segment_id:'email-clicou'}
  expect(await estimateBroadcastAudience(env,owner,audience)).toEqual({count:1,eligible:1})
  await env.DB.prepare('UPDATE contact_channels SET opted_in=0 WHERE workspace_id=? AND contact_id=?').bind('a',contactId).run()
  expect(await estimateBroadcastAudience(env,owner,audience)).toEqual({count:1,eligible:0})
  await expect(estimateBroadcastAudience(env,{...owner,workspaceId:'b'},{...audience,channel_id:'ch-b'})).rejects.toMatchObject({status:400})
  const foreign = await authenticatedRequest(`broadcasts/${b.id}`,'b')
  expect(foreign.status).toBe(404)
})

it('teste de e-mail: a recusa diz o motivo em vez de erro genérico e o envio passa quando a empresa está preenchida', async () => {
  const env = { ...runtime, APP_ENV:'development', CHANNEL_LIMITER:undefined, INBOUND:{send:vi.fn(async()=>{})} as unknown as Queue } as Env
  await initialize(env,'a')
  const owner = {workspaceId:'a',userId:'user-a',role:'owner' as const}
  const connection = await emailConnection(env,'a')
  const contactId = await emailContact(env,'a',connection,'cliente@exemplo.test',true)
  const email = {senderId:'email-default-a',subject:'Seu pedido',html:'<p>Confira</p>'}
  const b = await saveBroadcast(env,owner,{name:'Teste',content:'Confira',email,status:'draft',audience:{channel:'email',channel_id:connection,tag:'all'}})
  await env.DB.prepare("UPDATE email_settings SET company_name='',company_address='' WHERE workspace_id='a'").run()
  await expect(testBroadcast(env,owner,b.id,{contact_id:contactId})).rejects.toMatchObject({status:409,message:expect.stringMatching(/empresa/i)})
  await env.DB.prepare("UPDATE email_settings SET company_name='Empresa de estudo',company_address='Rua A, 123' WHERE workspace_id='a'").run()
  expect(await testBroadcast(env,owner,b.id,{contact_id:contactId})).toMatchObject({ok:true,test:true,parts:[{status:'sent'}]})
})
