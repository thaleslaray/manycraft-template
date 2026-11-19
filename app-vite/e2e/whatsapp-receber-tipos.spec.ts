import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from './fixtures'
import { WORKSPACE, ENGINE, api, consulta, sql, q, novoTag, pastaPrints } from './helpers'
import { encryptCredentials } from '../../engine/src/channels/core/crypto'

// O cliente manda texto, foto com legenda, documento, localização, contato e reação pela API oficial do WhatsApp; a caixa de entrada mostra cada um.
// Graph API falsa local (Media API incluída): nada sai da máquina. O webhook entra assinado, passa pela fila e o arquivo é baixado pelo motor.
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4); return out }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = y * (width * 3 + 1) + 1 + x * 3; rows[i] = 40 + x; rows[i + 1] = 90 + y; rows[i + 2] = 200 - x }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

test('whatsapp oficial: o que o cliente manda chega à caixa de entrada com o arquivo baixado', { tag: "@celular" }, async ({ page }, info) => {
  const tag = novoTag(), id = `e2e-recebe-${tag}`, phoneId = String(500000 + Math.floor(Math.random() * 199999)), user = `BR.E2E${tag.toUpperCase()}`
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'O ambiente local precisa de DEV_PROVIDER_API_BASE (Graph API falsa)').toBeTruthy()
  const base = catalog.development!.providerApiBase
  expect(new URL(base).hostname).toBe('127.0.0.1')
  const vars = readFileSync(resolve(import.meta.dirname, '../../engine/.dev.vars'), 'utf8')
  const version = vars.match(/^CONNECTIONS_KEK_ACTIVE=["']?(\d+)/m)![1]
  const key = vars.match(new RegExp(`^CONNECTIONS_KEK_V${version}=["']?([^\\r\\n"']+)`, 'm'))![1]
  const appSecret = `segredo-${tag}`
  const sealed = await encryptCredentials({ CONNECTIONS_KEK_ACTIVE: version, [`CONNECTIONS_KEK_V${version}`]: key }, { workspaceId: WORKSPACE, connectionId: id },
    { accessToken: 'TESTONLY', phoneNumberId: phoneId, wabaId: '456', appSecret, webhookSecret: `verifica-${tag}` })
  const files: Record<string, { mime: string; bytes: Buffer }> = {
    FOTO: { mime: 'image/png', bytes: png(160, 100) },
    DOC: { mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') },
  }
  const calls: string[] = []
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`)
    if (req.headers.authorization !== 'Bearer TESTONLY') { res.statusCode = 401; return res.end(JSON.stringify({ error: { code: 190, message: 'token' } })) }
    const lookup = req.url?.match(/^\/v\d+\.\d+\/([A-Z]+)$/), download = req.url?.match(/^\/download\/([A-Z]+)$/)
    const file = files[(lookup ?? download)?.[1] ?? '']
    if (!file) { res.statusCode = 400; return res.end(JSON.stringify({ error: { code: 100, error_subcode: 33, message: 'Object does not exist' } })) }
    if (download) { res.setHeader('content-type', file.mime); return res.end(file.bytes) }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ messaging_product: 'whatsapp', url: `${base}/download/${lookup![1]}`, mime_type: file.mime, sha256: 'x', file_size: file.bytes.length, id: lookup![1] }))
  })
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(Number(new URL(base).port), '127.0.0.1', ok) })
  const shots = pastaPrints("prontidao")
  mkdirSync(shots, { recursive: true })
  const device = info.project.name === 'desktop' ? 'desktop' : 'mobile'
  const now = Math.floor(Date.now() / 1000)
  const message = (n: number, fields: Record<string, unknown>) => ({ id: `wamid.E2E${tag}${n}`, from_user_id: user, timestamp: String(now + n), ...fields })
  const name = `Clara${tag}`   // o WhatsApp só guarda o primeiro nome do perfil
  try {
    sql([`INSERT INTO channels(id,workspace_id,type,provider,external_id,status,connection_state,display_name,settings,credentials_ciphertext,credentials_iv,credentials_key_version) VALUES ('${id}','${WORKSPACE}','whatsapp','meta_whatsapp_cloud','${phoneId}','connected','connected','Oficina Horizonte ${tag}','${q(JSON.stringify({ apiBase: base }))}','${sealed.ciphertext}','${sealed.iv}',${sealed.keyVersion})`])
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '456', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId, display_phone_number: '551140000000' },
      contacts: [{ profile: { name }, wa_id: '5511999990002', user_id: user }],
      messages: [
        message(1, { type: 'text', text: { body: `Oi, segue o recibo ${tag}` } }),
        message(2, { type: 'image', image: { id: 'FOTO', mime_type: 'image/png', sha256: 'x', caption: 'Foto do balcão' } }),
        message(3, { type: 'document', document: { id: 'DOC', mime_type: 'application/pdf', filename: 'recibo.pdf', caption: 'Recibo' } }),
        message(4, { type: 'location', location: { latitude: -23.5614, longitude: -46.6559, name: 'Avenida Paulista', address: 'São Paulo, SP' } }),
        message(5, { type: 'contacts', contacts: [{ name: { formatted_name: 'Barbara Johnson' }, org: { company: 'Social Tsunami' }, phones: [{ phone: '+55 11 99999-0000' }] }] }),
        message(6, { type: 'reaction', reaction: { message_id: `wamid.E2E${tag}1`, emoji: '👍' } }),
      ] } }] }] })
    const signature = `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`
    const delivered = await fetch(`${ENGINE}/api/webhooks/meta`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body })
    expect(delivered.status).toBe(200)
    // A fila entrega ao consumidor em segundo plano: espera o último arquivo ficar guardado.
    await expect.poll(() => consulta<{ n: number }>(`SELECT count(*) AS n FROM inbound_media WHERE channel_id='${id}' AND status='stored'`)[0]?.n, { timeout: 30_000 }).toBe(2)
    await expect.poll(() => consulta<{ n: number }>(`SELECT count(*) AS n FROM messages WHERE connection_id='${id}' AND direction='in'`)[0]?.n, { timeout: 30_000 }).toBe(5)
    expect(calls.filter(c => c.startsWith('GET /v')).length).toBe(2)

    await page.setViewportSize(device === 'desktop' ? { width: 1280, height: 1000 } : { width: 390, height: 1100 })
    await page.goto(`/${WORKSPACE}/inbox`)
    await page.getByRole('textbox', { name: /Buscar conversa/ }).fill(name)
    await page.getByRole('button', { name: new RegExp(`${name},`) }).click()
    const log = page.getByRole('log')
    await expect(log.getByText(`Oi, segue o recibo ${tag}`)).toBeVisible()
    await expect(log.getByText('Foto do balcão')).toBeVisible()
    const photo = log.getByRole('img', { name: 'Foto do balcão' })
    await expect(photo).toBeVisible()
    await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(160)   // a foto de verdade foi baixada e abre
    await expect(photo).toHaveAttribute('src', new RegExp(`^/api/inbox/media/[a-f0-9-]{36}\\?workspace=${WORKSPACE}$`))
    const document = log.getByRole('link', { name: /recibo\.pdf/ })
    await expect(document).toBeVisible()
    const file = await page.request.get(`${ENGINE}${(await document.getAttribute('href'))!}`, { headers: { 'x-workspace': WORKSPACE } })
    expect(file.status()).toBe(200)
    expect(file.headers()['content-disposition']).toBe('attachment')
    expect((await file.body()).subarray(0, 5).toString()).toBe('%PDF-')
    await expect(log.getByText('Avenida Paulista')).toBeVisible()
    await expect(log.getByRole('link', { name: 'Abrir no mapa' })).toHaveAttribute('href', 'https://www.google.com/maps?q=-23.5614,-46.6559')
    await expect(log.getByText('Barbara Johnson')).toBeVisible()
    await expect(log.getByText('+55 11 99999-0000')).toBeVisible()
    await expect(log.getByLabel('Reação do contato: 👍')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ animations: 'disabled', scale: 'css', path: resolve(shots, `04-recebido-${device}.png`) })
    await log.getByText(`Oi, segue o recibo ${tag}`).scrollIntoViewIfNeeded()
    await page.screenshot({ animations: 'disabled', scale: 'css', path: resolve(shots, `05-recebido-foto-${device}.png`) })
  } finally {
    await new Promise<void>(ok => server.close(() => ok()))
    sql([`DELETE FROM messages WHERE workspace_id='${WORKSPACE}' AND connection_id='${id}'`,
      `DELETE FROM conversations WHERE workspace_id='${WORKSPACE}' AND contact_channel_id IN (SELECT id FROM contact_channels WHERE channel_id='${id}')`,
      `DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT contact_id FROM contact_channels WHERE channel_id='${id}')`,
      `DELETE FROM whatsapp_numbers WHERE workspace_id='${WORKSPACE}' AND first_connection_id='${id}'`,
      `DELETE FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND channel_id='${id}'`,
      `DELETE FROM media_objects WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT media_id FROM inbound_media WHERE channel_id='${id}')`,
      `DELETE FROM inbound_media WHERE channel_id='${id}'`,
      `DELETE FROM inbound_events WHERE channel_id='${id}'`,
      `DELETE FROM channels WHERE id='${id}'`])
  }
})
