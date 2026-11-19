import { env } from 'cloudflare:workers'
import handler from '../src/index'
import { beforeEach, expect, it, vi } from 'vitest'
import { can, type Role } from '../src/permissions'
import { limit } from '../src/security'
import { sendEmail } from '../src/email'

beforeEach(async () => { await env.DB.prepare('DELETE FROM request_limits').run(); await env.DB.prepare('DELETE FROM email_outbox').run() })
it('papéis têm fronteiras explícitas e nenhuma permissão entre workspaces', () => {
  for (const role of ['owner','administrator','editor','livechat_agent','viewer'] as Role[]) {
    const user = { userId: 'person', workspaceId: 'a', role }
    expect(can(user, 'read', { workspace_id: 'b' })).toBe(false)
    expect(can(user, 'team', { workspace_id: 'a' })).toBe(['owner','administrator'].includes(role))
    expect(can(user, 'edit', { workspace_id: 'a' })).toBe(['owner','administrator','editor'].includes(role))
    expect(can(user, 'upload', { workspace_id: 'a' })).toBe(['owner','administrator','editor'].includes(role))
  }
  expect(can(null, 'read', { workspace_id: 'a' })).toBe(false)
})
it('limite atômico suporta concorrência e só persiste chave opaca', async () => {
  const results = await Promise.allSettled(Array.from({length: 8}, () => limit(env, 'private@example.test', 3)))
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3)
  const row = await env.DB.prepare('SELECT key,count FROM request_limits').first<{key:string;count:number}>()
  expect(row).toMatchObject({count: 8})
  expect(row!.key).not.toContain('private')
  await env.DB.prepare('UPDATE request_limits SET reset_at=0').run()
  await expect(limit(env, 'private@example.test', 3)).resolves.toBeUndefined()
})
it('e-mail fica somente no D1 dev; produção usa binding e falha fechado se ausente', async () => {
  const log = vi.spyOn(console, 'log')
  await sendEmail(env, 'fiction@example.test', 'invite', 'https://engine.test/invite#fake-token')
  expect(await env.DB.prepare('SELECT kind FROM email_outbox').first()).toEqual({kind:'invite'})
  expect(log).not.toHaveBeenCalled()
  log.mockRestore()
  const send = vi.fn(async () => ({ messageId:'fake' }))
  await sendEmail({ ...env, APP_ENV: 'production', EMAIL: {send} as unknown as SendEmail, EMAIL_FROM: 'team@example.test' }, 'fiction@example.test', 'reset', 'https://engine.test/reset')
  expect(send).toHaveBeenCalledWith(expect.objectContaining({to:'fiction@example.test',subject:'Escolha uma nova senha'}))
  await expect(sendEmail({ ...env, APP_ENV:'production' }, 'absent@example.test', 'reset', 'https://engine.test/reset')).rejects.toMatchObject({status:503})
  for (let i=0;i<3;i++) await sendEmail(env, 'fiction@example.test', 'verification', 'https://engine.test/verify')
  await expect(sendEmail(env, 'fiction@example.test', 'verification', 'https://engine.test/verify')).rejects.toMatchObject({status:429})
})
it('Cron apaga e-mails dev antigos, convites e contadores vencidos', async () => {
  await sendEmail(env, 'fiction@example.test', 'magic', 'https://engine.test')
  await env.DB.prepare('UPDATE email_outbox SET created_at=0').run()
  await env.DB.prepare('UPDATE request_limits SET reset_at=0').run()
  await handler.scheduled({ scheduledTime: Date.now(), cron:'0 3 * * *', noRetry(){} }, env)
  expect((await env.DB.prepare('SELECT * FROM email_outbox').all()).results).toHaveLength(0)
  expect((await env.DB.prepare('SELECT * FROM request_limits').all()).results).toHaveLength(0)
})
