import type { ContractFixture } from './fixtures'

/** Z-API classic (api.z-api.io, instances). Shapes follow the examples of the docs-zapi skill: webhooks/on-message-received-examples.md,
 * on-whatsapp-message-status-changes.md, on-message-send.md, on-webhook-connected.md, on-whatsapp-disconnected.md. The test values below are made up. */
export const ZAPI_INSTANCE = 'A0000000000000000000000000000000', ZAPI_TOKEN = 'TOKENTESTONLY0123456789', ZAPI_CLIENT_TOKEN = 'client-token-testonly-1', HOOK_SECRET = 'hook-secret'
export const ZAPI_USER = '5511888888888', ZAPI_OWNER = '5511999999999'
export const buttonToken = `b:${'a'.repeat(24)}`
export const hookQuery = (secret = HOOK_SECRET) => `k=${encodeURIComponent(secret)}`

type Over = { id?: string; fromMe?: boolean; fromApi?: boolean; text?: string | null; phone?: string; name?: string; group?: boolean; edit?: boolean; extra?: Record<string, unknown> }
/** A ReceivedCallback. */
export function zapiMessage(over: Over = {}) {
  const id = over.id ?? 'IN0000000000000000000000000000001'
  return {
    isStatusReply: false, senderLid: '81896604192873@lid', connectedPhone: ZAPI_OWNER, waitingMessage: false, isEdit: over.edit ?? false, isGroup: over.group ?? false, isNewsletter: false,
    instanceId: ZAPI_INSTANCE, messageId: id, phone: over.phone ?? ZAPI_USER, fromMe: over.fromMe ?? false, momment: Date.now() - 2000, status: over.fromMe ? 'SENT' : 'RECEIVED',
    chatName: 'Ana', senderPhoto: null, senderName: over.name ?? (over.fromMe ? ZAPI_OWNER : 'Ana'), participantPhone: null, participantLid: null, photo: null, broadcast: false,
    type: 'ReceivedCallback', ...(over.fromApi === undefined ? {} : { fromApi: over.fromApi }),
    ...(over.text === null ? {} : { text: { message: over.text ?? 'quero' } }), ...over.extra,
  }
}
export const zapiClick = (id = 'CLICK000000000000000000000000001', buttonId = buttonToken) => zapiMessage({ id, text: null,
  extra: { referenceMessageId: 'OUT1', buttonsResponseMessage: { buttonId, message: 'Ir' } } })
export const zapiStatus = (status: string, ids: string[], over: Record<string, unknown> = {}) =>
  ({ instanceId: ZAPI_INSTANCE, status, ids, momment: Date.now() - 1000, phoneDevice: 0, phone: ZAPI_USER, type: 'MessageStatusCallback', isGroup: false, ...over })
export const zapiDelivery = (id: string, error?: string) =>
  ({ phone: ZAPI_USER, zaapId: id, messageId: id, instanceId: ZAPI_INSTANCE, momment: Date.now() - 1000, type: 'DeliveryCallback', ...(error ? { error } : {}) })
export const zapiConnected = { type: 'ConnectedCallback', connected: true, momment: 1777494009341, instanceId: ZAPI_INSTANCE, phone: ZAPI_OWNER }
export const zapiDisconnected = { type: 'DisconnectedCallback', disconnected: true, error: 'Device has been disconnected', momment: 1777494019341, instanceId: ZAPI_INSTANCE }

const HOOK_URL = `https://x.test/api/hooks/conn?${hookQuery()}`
export const zapiFixture: ContractFixture = {
  credentials: { instanceId: ZAPI_INSTANCE, token: ZAPI_TOKEN, clientToken: ZAPI_CLIENT_TOKEN, webhookSecret: HOOK_SECRET }, webhookSecret: HOOK_SECRET,
  user: { id: ZAPI_USER, messageId: 'IN0000000000000000000000000000001', text: 'quero' },
  inbound: {
    text: zapiMessage(),
    click: zapiClick(),
    // The echo of a send made through the API (notify sent by me is on): never a message from the contact.
    ownEcho: zapiMessage({ id: 'ECHO00000000000000000000000000001', fromMe: true, fromApi: true, text: 'eco' }),
    unknownType: zapiMessage({ id: 'IMG00000000000000000000000000001', text: null, extra: { image: { imageUrl: 'https://x.test/a.png', mimeType: 'image/png' } } }),
    eventKey: 'IN0000000000000000000000000000001', clickPayload: buttonToken, clickAck: false,
  },
  // Classic Z-API sends no header and no signature: the secret rides in the query of the URL we registered.
  authQuery: { valid: hookQuery(), tampered: hookQuery('outro-segredo') },
  headersFor: async () => ({}),
  tamperedFor: async () => ({}),
  unconfigured: { webhookSecret: '', credentials: { instanceId: ZAPI_INSTANCE, token: ZAPI_TOKEN, clientToken: ZAPI_CLIENT_TOKEN } },
  webhook: { mode: 'auto', body: { value: HOOK_URL } },
  connect: { ok: Response.json({ connected: true, error: 'You are already connected', smartphoneConnected: true }), refused: Response.json({ error: 'null not allowed' }, { status: 401 }), externalId: `zapi:${ZAPI_INSTANCE}` },
  responses: {
    ok: Response.json({ zaapId: '3999984263738042930CD6ECDE9VDWSA', messageId: 'D241XXXX732339502B68', id: 'D241XXXX732339502B68' }),
    rateLimited: Response.json({ error: 'rate limit' }, { status: 429, headers: { 'Retry-After': '3' } }),
    rejected: Response.json({ error: 'Phone number does not exist' }, { status: 400 }),
    malformed: new Response('<html>', { status: 502 }),
  },
  receipts: { body: zapiStatus('RECEIVED', ['D241XXXX732339502B68']), externalMessageId: 'D241XXXX732339502B68', status: 'delivered' },
}
