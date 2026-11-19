import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { giveCredentials } from './credentials'
import { ensureConversation, type Conversation } from '../src/inbox/service'

beforeEach(async()=>{
  await seedAuth()
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,capabilities_override) VALUES ('wa-override','a','whatsapp','meta_whatsapp_cloud','123',?)")
    .bind(JSON.stringify({window:{standardHours:1}})).run()
  await giveCredentials(env,'wa-override',{accessToken:'TESTONLY',phoneNumberId:'123'})
  await env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,opted_in) VALUES ('cc-override','a','c-a','wa-override','BR.testonly','bsuid',1)").run()
  await ensureConversation(env,'a','c-a','wa-override')
  vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw new Error('Rede real proibida')})
})
afterEach(()=>vi.restoreAllMocks())
const policy=async()=>{
  const list=await (await authenticatedRequest('inbox/conversations?status=all')).json() as {rows:Conversation[]}
  return list.rows[0].reply_policy
}

it('janela de uma hora da conexão vence mesmo com prazo antigo de 24h no banco, e impede envio',async()=>{
  const lastInbound=Date.now()-2*3600_000
  await env.DB.prepare("UPDATE contact_channels SET last_inbound_at=?,window_expires_at=?,human_window_expires_at=NULL WHERE id='cc-override'")
    .bind(lastInbound,lastInbound+24*3600_000).run()
  expect(await policy()).toMatchObject({can_reply:false,expires_at:new Date(lastInbound+3600_000).toISOString()})
  const response=await authenticatedRequest('inbox/conversations/inbox-cc-override/messages','a',{
    method:'POST',body:JSON.stringify({kind:'reply',text:'Texto fora do prazo reduzido'}),
  })
  expect(response.status).toBe(409)
  expect(fetch).not.toHaveBeenCalled()
})

it('a ficha não prolonga um prazo armazenado que vence antes do limite declarado',async()=>{
  const now=Date.now(),storedDeadline=now+15*60_000
  await env.DB.prepare("UPDATE contact_channels SET last_inbound_at=?,window_expires_at=?,human_window_expires_at=NULL WHERE id='cc-override'")
    .bind(now-30*60_000,storedDeadline).run()
  expect(await policy()).toMatchObject({can_reply:true,expires_at:new Date(storedDeadline).toISOString()})
  expect(fetch).not.toHaveBeenCalled()
})
