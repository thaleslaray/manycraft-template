import type { ContractFixture } from './fixtures'

export const emailFixture: ContractFixture = {
  native: true,
  credentials: {}, webhookSecret: 'not-an-http-hook',
  connection: { externalId: 'oi@example.test', settings: { senderAddress: 'oi@example.test' } },
  binding: fake => ({ email: { send: async () => {
    const response = await fake()
    if (response.status === 429) throw Object.assign(new Error('limited'), { code: 'E_RATE_LIMIT_EXCEEDED' })
    if (!response.ok && response.status < 500) throw Object.assign(new Error('rejected'), { code: String(response.status) })
    return response.json()
  } } }),
  user: { id: 'ana@example.test', messageId: '<in@example.test>', text: 'quero' },
  inbound: {
    text: { type: 'reply', messageId: '<in@example.test>', from: 'ana@example.test', text: 'quero', inReplyTo: '<sent@example.test>', verifiedReply: true },
    click: { type: 'click', eventId: 'click:1', from: 'ana@example.test', messageId: '<sent@example.test>', url: 'https://example.test' },
    ownEcho: { type: 'reply', messageId: '<echo@example.test>', from: 'oi@example.test', text: 'eco', inReplyTo: '<sent@example.test>', verifiedReply: true },
    unknownType: { type: 'unknown', messageId: '<unknown@example.test>' },
    eventKey: '<in@example.test>', clickPayload: 'https://example.test', clickAck: false,
  },
  headersFor: async () => ({}), tamperedFor: async () => ({}), unconfigured: { webhookSecret: '', credentials: {} },
  webhook: { mode: 'manual' }, connect: { ok: Response.json({}), refused: Response.json({}, { status: 403 }), externalId: 'oi@example.test' },
  responses: { ok: Response.json({ messageId: '<out@example.test>' }), rateLimited: Response.json({}, { status: 429 }), rejected: Response.json({}, { status: 400 }), malformed: new Response('<html>', { status: 502 }) },
}
