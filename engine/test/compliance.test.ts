import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

beforeEach(seedAuth)

it('conformidade: conexão com erro e descadastro alto aparecem como risco; espaço limpo fica ok', async () => {
  const get = async () => await (await authenticatedRequest('compliance')).json() as { status: string; issues: { kind: string; severity: string }[] }
  expect((await get()).status).toBe('ok')
  await env.DB.prepare("UPDATE channels SET status='error' WHERE workspace_id='a'").run()
  for (let i = 0; i < 6; i++) await env.DB.prepare("INSERT INTO contacts (id,workspace_id,status) VALUES (?,'a','subscribed')").bind(`out-${i}`).run()
  await env.DB.prepare("UPDATE contacts SET status='unsubscribed' WHERE id LIKE 'out-%'").run()
  const report = await get()
  expect(report.status).toBe('at_risk')
  expect(report.issues.map(i => i.kind)).toEqual(expect.arrayContaining(['connection', 'opt_out']))
})
