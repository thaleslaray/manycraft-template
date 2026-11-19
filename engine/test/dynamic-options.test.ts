import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { callDynamic, dynamicConfigSchema } from '../src/flow/dynamic-block'
import { ExternalRequestError } from '../src/flow/external-url'

it('bloco dinâmico aceita método, cabeçalhos e corpo próprios', async () => {
  expect(dynamicConfigSchema.parse({ url: 'https://x.example/a' })).toMatchObject({ method: 'POST', headers: [] })
  const fetcher = vi.fn(async (_: unknown, init?: RequestInit) => Response.json({ version: 'v2', content: { messages: [{ type: 'text', text: String(init?.method) }] } }))
  const r = await callDynamic(env as never, 'https://x.example/a', {}, fetcher as never, { method: 'PUT', headers: { 'x-chave': '1' }, rawBody: '{"a":1}' })
  expect(r.content.messages[0]).toMatchObject({ text: 'PUT' })
  const init = fetcher.mock.calls[0][1] as RequestInit
  expect(init.body).toBe('{"a":1}')
  expect((init.headers as Record<string, string>)['x-chave']).toBe('1')
})

it('corpo que trava ou cai no meio da leitura vira ExternalRequestError (timeout ou rede); o de mais de 1 MB segue too_large', async () => {
  const call = (response: () => Response) => callDynamic(env as never, 'https://x.example/a', {}, (async () => response()) as never).then(() => undefined, (error: unknown) => error)
  const failing = (error: Error) => new Response(new ReadableStream({ pull(controller) { controller.error(error) } }), { status: 200 })
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  for (const [response, code] of [[() => failing(timeout), 'timeout'], [() => failing(new TypeError('Network connection lost')), 'network'],
    [() => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }), 'too_large']] as const) {
    const error = await call(response)
    expect(error, code).toBeInstanceOf(ExternalRequestError)
    expect((error as ExternalRequestError).code).toBe(code)
  }
})
