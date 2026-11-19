import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { contactsCsv } from '../src/contacts-csv'

beforeEach(seedAuth)
const post = (path: string, body: unknown, workspace = 'a') => authenticatedRequest(path, workspace, { method: 'POST', body: JSON.stringify(body) })

it('CSV de contatos: cabeçalho em pt-BR, gênero traduzido, aspas e fórmulas neutralizadas', () => {
  const csv = contactsCsv([{ first_name: 'Ana', last_name: 'Souza, Jr', email: '=cmd@x.com', phone: '5511999990000', gender: 'female', status: 'subscribed', subscribed_at: Date.UTC(2026, 9, 1, 10), tags: [{ name: 'vip' }, { name: 'br' }] }])
  const [head, line] = csv.replace(/^﻿/, '').split('\r\n')
  expect(head).toBe('Nome,Sobrenome,E-mail,Telefone,Gênero,Status,Inscrito em,Tags')
  expect(line).toBe('Ana,"Souza, Jr",\'=cmd@x.com,5511999990000,Feminino,Inscrito,2026-10-01,vip; br')
})

it('exporta os contatos filtrados e os selecionados, sem os excluídos nem os de outro espaço', async () => {
  const now = Date.now()
  for (const [id, ws, first, status, gender] of [['x1', 'a', 'Zeca', 'subscribed', 'male'], ['x2', 'a', 'Zuleica', 'subscribed', 'female'], ['x3', 'a', 'Zorro', 'deleted', null], ['x4', 'b', 'Zacarias', 'subscribed', null]] as const) {
    await env.DB.prepare('INSERT INTO contacts (id,workspace_id,first_name,gender,status,subscribed_at,created_at) VALUES (?,?,?,?,?,?,?)').bind(id, ws, first, gender, status, now, now).run()
  }
  const filtered = await post('contacts/export', { query: { search: 'Z' } })
  expect(filtered.status).toBe(200)
  const body = await filtered.json() as { csv: string; count: number; file_name: string }
  expect(body.count).toBe(2)
  expect(body.csv).toContain('Zeca')
  expect(body.csv).toContain('Masculino')
  expect(body.csv).not.toContain('Zorro')
  expect(body.csv).not.toContain('Zacarias')
  expect(body.file_name).toMatch(/^contatos-\d{4}-\d{2}-\d{2}\.csv$/)
  const picked = await (await post('contacts/export', { ids: ['x2', 'x3', 'x4'] })).json() as { csv: string; count: number }
  expect(picked.count).toBe(1)
  expect(picked.csv).toContain('Zuleica')
  const advanced = await (await post('contacts/export', { filter: { match: 'all', rules: [{ type: 'system', field: 'gender', operator: 'equals', value: 'male' }] } })).json() as { csv: string; count: number }
  expect(advanced.count).toBe(1)
  expect(advanced.csv).toContain('Zeca')
  expect((await post('contacts/export', { ids: [] })).status).toBe(400)
})
