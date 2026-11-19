import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { triggerTypeOf, typeAndChannel } from '../../shared/trigger-types'

beforeEach(seedAuth)

const widget = (id: string, type: string, channel: string | null, automation = 'auto-a') =>
  env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,config) VALUES (?,?,?,?,?,'widget',?,'active','{}')")
    .bind(id, 'a', automation, channel, id, type)

it('um gatilho widget sem conexão é recusado pelo banco', async () => {
  await expect(widget('sem-canal', 'feed_comment', null).run()).rejects.toThrow(/exige uma conex/)
  await widget('com-canal', 'feed_comment', 'ch-a').run()
  await expect(env.DB.prepare("UPDATE triggers SET channel_id=NULL WHERE id='com-canal'").run()).rejects.toThrow(/exige uma conex/)
})

it('a lista de automações mostra tipo e canal do primeiro gatilho e quantos mais existem', async () => {
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('ch-wa','a','whatsapp','wa-1')").run()
  await env.DB.prepare("INSERT INTO automations(id,workspace_id,name,draft_graph) SELECT 'auto-ref','a','Link',draft_graph FROM automations WHERE id='auto-a'").run()
  await widget('ref-wa', 'messenger_ref_url', 'ch-wa', 'auto-ref').run()
  const list = await (await authenticatedRequest('automations')).json() as { id: string; trigger_type: string | null; trigger_channel: string | null; trigger_count: number }[]
  expect(list.find(a => a.id === 'auto-ref')).toMatchObject({ trigger_type: 'ref_url', trigger_channel: 'whatsapp', trigger_count: 1 })
  expect(list.find(a => a.id === 'auto-a')).toMatchObject({ trigger_type: 'dm_keyword', trigger_channel: 'instagram', trigger_count: 1 })
  await widget('comentario', 'feed_comment', 'ch-a').run()
  expect((await (await authenticatedRequest('automations')).json() as { id: string; trigger_count: number }[]).find(a => a.id === 'auto-a')!.trigger_count).toBe(2)
  const filtered = await (await authenticatedRequest('automation-library?trigger_type=ref_url')).json() as { items: { id: string; trigger_type: string; trigger_channel: string }[] }
  expect(filtered.items.map(a => a.id)).toEqual(['auto-ref'])
  expect(filtered.items[0]).toMatchObject({ trigger_type: 'ref_url', trigger_channel: 'whatsapp' })
})

it('o detalhe da automação informa o canal de cada gatilho', async () => {
  await widget('story', 'instagram_story_reply', 'ch-a').run()
  const detail = await (await authenticatedRequest('automations/auto-a')).json() as { triggers: { id: string; type: string; channel_type: string }[] }
  expect(detail.triggers.find(t => t.id === 'story')).toMatchObject({ type: 'ig_story_reply', channel_type: 'instagram' })
})

it('o mapeamento tipo-do-banco para tipo-da-tela e o rótulo "Tipo · Canal"', () => {
  expect(triggerTypeOf('widget', 'feed_comment_trigger')).toBe('ig_comment')
  expect(triggerTypeOf('widget', 'messenger_ref_url')).toBe('ref_url')
  expect(triggerTypeOf('ice_breaker', null)).toBe('api')
  expect(typeAndChannel('ref_url', 'whatsapp')).toBe('Link de referência · WhatsApp')
  expect(typeAndChannel('dm_keyword', null)).toBe('Palavra-chave')
})
