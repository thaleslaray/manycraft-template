import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import type { AutomationStats } from '../src/db/automation-stats'

beforeEach(seedAuth)

const event = (node: string, type: string, button: string | null = null, ws = 'a') =>
  env.DB.prepare('INSERT INTO node_events (workspace_id,automation_id,node_id,button_id,contact_id,type) VALUES (?,?,?,?,?,?)')
    .bind(ws, `auto-${ws}`, node, button, `c-${ws}`, type)

it('conta envios e cliques por nó e botão a partir de node_events, só do próprio workspace', async () => {
  await env.DB.batch([event('m1', 'sent'), event('m1', 'sent'), event('m1', 'clicked', 'b1'), event('m2', 'sent'), event('m1', 'sent', null, 'b')])
  const response = await authenticatedRequest('automations/auto-a/stats?period_days=7')
  expect(response.status).toBe(200)
  const stats = await response.json() as AutomationStats
  expect(stats).toEqual({ automation_id: 'auto-a', period_days: 7, runs: 2, unique_contacts: 1,
    nodes: { m1: { sent: 2, clicked: 1, buttons: { b1: 1 } }, m2: { sent: 1 } } })
  expect((await authenticatedRequest('automations/auto-b/stats')).status).toBe(404)
  expect((await authenticatedRequest('automations/auto-a/stats?period_days=0')).status).toBe(400)
})

it('lista campos personalizados só do próprio workspace', async () => {
  const response = await authenticatedRequest('fields')
  expect(response.status).toBe(200)
  const rows = await response.json() as { id: string; workspace_id: string }[]
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.every(r => r.workspace_id === 'a')).toBe(true)
})
