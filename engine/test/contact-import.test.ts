import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import worker from '../src/index'

beforeEach(seedAuth)
const request = (path: string, method = 'GET', body?: unknown, workspace = 'a') => authenticatedRequest(path, workspace, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

it('importa em fila cinco linhas com duplicada, relatório e retomada idempotente sem rede', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rede proibida'))
  const messages: unknown[] = []
  const bindings = { ...env, INBOUND: { send: async (body: unknown) => { messages.push(body) } } as unknown as Queue }
  const submit = (body: unknown, workspace = 'a') => authenticatedRequest('contact-imports', workspace, { method: 'POST', body: JSON.stringify(body) }, undefined, bindings)
  const input = {
    file_name: 'pessoas.csv', consent: true, tag_ids: ['tag-a'],
    mapping: { first_name: 0, email: 1, 'field:field-a': 2 },
    csv: 'Nome;Email;Interesse\nAna;ANA@example.test;Oficina\nBruno;bruno@example.test;Curso\nAna revisada;ana@example.test;Encontro\nInválida;sem-arroba;Curso\nClara;clara@example.test;Oficina',
  }
  try {
    expect((await submit({ ...input, consent: false })).status).toBe(400)
    expect((await submit({ ...input, tag_ids: ['tag-b'] })).status).toBe(404)
    expect((await submit({ ...input, mapping: { first_name: 0, email: 1, 'field:field-b': 2 } })).status).toBe(404)
    const response = await submit(input)
    expect(response.status).toBe(202)
    const job = await response.json() as any
    expect(job).toMatchObject({ status: 'queued', total: 5, processed: 0 })
    expect((await request(`contact-imports/${job.id}`, 'GET', undefined, 'b')).status).toBe(404)
    expect((await (await request('contacts?search=revisada')).json() as any).total).toBe(0)
    const original = messages[0]
    const deliver = async (body: unknown) => {
      const retry = vi.fn(), ack = vi.fn()
      await worker.queue({ messages: [{ body, attempts: 1, ack, retry }] } as unknown as MessageBatch<unknown>, bindings)
      expect(retry).not.toHaveBeenCalled()
      expect(ack).toHaveBeenCalled()
    }
    for (let i = 0; i < messages.length; i++) await deliver(messages[i])
    await deliver(original) // Queue delivery may be repeated after a committed batch.
    const report = await (await request(`contact-imports/${job.id}`)).json() as any
    expect(report).toMatchObject({ status: 'completed', total: 5, processed: 5, created: 3, updated: 1, ignored: 1 })
    expect(report.ignored_rows).toEqual([{ line: 5, reason: 'E-mail inválido.' }])
    const contacts = await (await request('contacts?search=revisada')).json() as any
    expect(contacts.rows).toHaveLength(1)
    const detail = await (await request(`contacts/${contacts.rows[0].id}`)).json() as any
    expect(detail.contact.email).toBe('ana@example.test')
    expect(detail.field_values).toContainEqual({ contact_id: detail.contact.id, field_id: 'field-a', value: 'Encontro' })
    expect(detail.tags.map((t: any) => t.id)).toEqual(['tag-a'])
    expect(detail.channels).toEqual([]) // Imported addresses grant no messaging identity or connection consent.
    expect(network).not.toHaveBeenCalled()
  } finally { network.mockRestore() }
})

it('cria contato com telefone normalizado e bloqueia duplicados apenas no mesmo workspace', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rede proibida'))
  try {
    const input = { first_name: 'Ana', last_name: 'Lima', phone: '+55 (11) 99999-1234', email: ' ANA@EXAMPLE.TEST ' }
    const created = await request('contacts', 'POST', input)
    expect(created.status).toBe(201)
    const contact = await created.json() as any
    expect(contact).toMatchObject({ first_name: 'Ana', phone: '5511999991234', email: 'ana@example.test' })
    expect((await (await request(`contacts/${contact.id}`)).json() as any).contact).toMatchObject({ phone: '5511999991234', email: 'ana@example.test' })
    expect((await request('contacts', 'POST', { ...input, email: 'outra@example.test' })).status).toBe(409)
    expect((await request('contacts', 'POST', { ...input, phone: '5521999994321' })).status).toBe(409)
    const concurrent = await Promise.all([1, 2].map(() => request('contacts', 'POST', { ...input, email: 'race@example.test', phone: '5531999994321' })))
    expect(concurrent.map(r => r.status).sort()).toEqual([201, 409])
    expect((await request('contacts', 'POST', input, 'b')).status).toBe(201)
    for (const bad of [{ ...input, email: 'invalido' }, { ...input, phone: 'abc5511999991234' }, { ...input, phone: '12' }]) {
      expect((await request('contacts', 'POST', bad)).status).toBe(400)
    }
    await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE workspace_id='a'").run()
    expect((await request('contacts', 'POST', input)).status).toBe(403)
    expect(network).not.toHaveBeenCalled()
  } finally { network.mockRestore() }
})

it('retoma um lote interrompido após 25 linhas, casa por telefone e recusa identidades conflitantes', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rede proibida'))
  const messages: unknown[] = []
  let failNext = false
  const bindings = { ...env, INBOUND: { send: async (body: unknown) => {
    if (failNext) { failNext = false; throw new Error('Fila indisponível') }
    messages.push(body)
  } } as unknown as Queue }
  const submit = (body: unknown) => authenticatedRequest('contact-imports', 'a', { method: 'POST', body: JSON.stringify(body) }, undefined, bindings)
  try {
    const first = await (await request('contacts', 'POST', { first_name: 'Original', email: 'original@example.test', phone: '5511999991234' })).json() as any
    await request('contacts', 'POST', { email: 'outra@example.test', phone: '5521999991234' })
    const input = { file_name: 'lote.csv', consent: true, mapping: { first_name: 0, phone: 1, email: 2 },
      csv: ['\uFEFFNome;Telefone;Email', 'Revisada;+55 (11) 99999-1234;novo@example.test',
        'Conflito;5511999991234;outra@example.test',
        ...Array.from({ length: 26 }, (_, i) => `"Pessoa ""${i}""";;pessoa${i}@example.test`)].join('\r\n') }
    expect((await submit({ ...input, csv: 'Nome;Email\n"Aspas abertas;ana@example.test' })).status).toBe(400)
    const response = await submit(input)
    expect(response.status).toBe(202)
    const job = await response.json() as any
    const deliver = async (attempts: number) => {
      const ack = vi.fn(), retry = vi.fn()
      await worker.queue({ messages: [{ body: messages[0], attempts, ack, retry }] } as unknown as MessageBatch<unknown>, bindings)
      return { ack, retry }
    }
    failNext = true
    expect((await deliver(1)).retry).toHaveBeenCalled()
    expect(await (await request(`contact-imports/${job.id}`)).json()).toMatchObject({ status: 'processing', processed: 25, total: 28 })
    const resumed = await deliver(2)
    expect(resumed.retry).not.toHaveBeenCalled()
    expect(resumed.ack).toHaveBeenCalled()
    expect(await (await request(`contact-imports/${job.id}`)).json()).toMatchObject({ status: 'completed', created: 26, updated: 1, ignored: 1, processed: 28 })
    expect((await (await request(`contacts/${first.id}`)).json() as any).contact).toMatchObject({ first_name: 'Revisada', email: 'novo@example.test', phone: '5511999991234' })
    expect((await (await request('contacts?search=Pessoa')).json() as any).total).toBe(26)
    expect(network).not.toHaveBeenCalled()
  } finally { network.mockRestore() }
})
