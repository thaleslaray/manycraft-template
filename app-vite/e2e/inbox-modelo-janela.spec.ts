import { createServer } from 'node:http'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from './fixtures'
import { WORKSPACE, api, sql, q, novoTag, contatoSql, pastaPrints } from './helpers'
import { encryptCredentials } from '../../engine/src/channels/core/crypto'

test('inbox: ficha efetiva, modelo aprovado com variáveis e extensão humana', { tag: "@celular" }, async ({ page }, info) => {
  const tag = novoTag(), prefix = `e2e-inbox31-${tag}`
  const catalog = await api<{ development: { providerApiBase: string } }>('/api/connections/catalog')
  const base = catalog.development.providerApiBase
  expect(new URL(base).hostname).toBe('127.0.0.1')
  const vars = readFileSync(resolve(import.meta.dirname, '../../engine/.dev.vars'), 'utf8')
  const version = vars.match(/^CONNECTIONS_KEK_ACTIVE=["']?(\d+)/m)![1]
  const key = vars.match(new RegExp(`^CONNECTIONS_KEK_V${version}=["']?([^\\r\\n"']+)`, 'm'))![1]
  const calls: { url: string; body: Record<string, any> }[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      // O servidor falso é o mesmo de todas as jornadas: conexões de Telegram que outras deixaram no banco pedem foto de perfil
      // (`/bot<token>/getUserProfilePhotos`) quando o inbox mostra os avatares. Só contam os pedidos das conexões desta jornada.
      if (req.url?.startsWith('/bot')) { res.statusCode = 404; return res.end('{}') }
      calls.push({ url: req.url ?? '', body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/send/text') return res.end(JSON.stringify({ id: `fake-${calls.length}` }))
      if (req.url?.endsWith('/123/messages')) return res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `fake-${calls.length}` }] }))
      if (req.url?.endsWith('/789/messages')) return res.end(JSON.stringify({ message_id: `fake-${calls.length}`, recipient_id: '456' }))
      res.statusCode = 404; res.end('{}')
    })
  })
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(Number(new URL(base).port), '127.0.0.1', ok) })
  const now = Date.now(), shots = pastaPrints("clone-screens")
  mkdirSync(shots, { recursive: true })
  const device = info.project.name === 'desktop' ? 'desktop' : 'mobile'
  await page.setViewportSize(device === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 })
  try {
    for (const [suffix, kind, provider, credentials, recipient] of [
      ['oficial', 'whatsapp', 'meta_whatsapp_cloud', { accessToken: 'TESTONLY', phoneNumberId: '123' }, 'BR.testonly'],
      ['livre', 'whatsapp', 'uazapi', { token: 'TESTONLY', serverUrl: 'https://uazapi.example.test' }, '5511999999999@s.whatsapp.net'],
      ['humano', 'instagram', 'instagram_unified', { accessToken: 'TESTONLY', accountId: '789' }, '456'],
    ] as const) {
      const id = `${prefix}-${suffix}`
      const sealed = await encryptCredentials({ CONNECTIONS_KEK_ACTIVE: version, [`CONNECTIONS_KEK_V${version}`]: key }, { workspaceId: WORKSPACE, connectionId: id }, credentials)
      sql([
        `INSERT INTO channels(id,workspace_id,type,provider,external_id,status,connection_state,settings,credentials_ciphertext,credentials_iv,credentials_key_version) VALUES ('${id}','${WORKSPACE}','${kind}','${provider}','${id}-ext','connected','connected','${q(JSON.stringify({ apiBase: base, serverUrl: base }))}','${sealed.ciphertext}','${sealed.iv}',${sealed.keyVersion})`,
        ...contatoSql({ id, canal: id, nome: 'Nara', sobrenome: `${suffix}${tag}`, conversa: { id, mensagens: [{ id: `${id}-in`, texto: 'Podemos continuar o atendimento?' }] } }).map(statement => statement.startsWith('INSERT INTO contact_channels')
          ? `INSERT INTO contact_channels(workspace_id,id,contact_id,channel_id,external_user_id,opted_in,identity_kind,address_kind) VALUES ('${WORKSPACE}','${id}-cc','${id}','${id}','${recipient}',1,'${suffix === 'oficial' ? 'bsuid' : 'provider_id'}','${suffix === 'oficial' ? 'bsuid' : suffix === 'livre' ? 'wa_pn' : 'igsid'}')` : statement),
        `UPDATE contact_channels SET last_inbound_at=${now - 48 * 3600_000},window_expires_at=${now - 24 * 3600_000},human_window_expires_at=${now + 5 * 86400_000} WHERE id='${id}-cc'`,
      ])
    }
    sql([`INSERT INTO message_templates(id,workspace_id,channel_id,group_id,name_human,language_code,body,status,example) VALUES ('${prefix}-modelo','${WORKSPACE}','${prefix}-oficial','${prefix}-grupo','retorno_${tag}','pt_BR','Olá {{1}}, seu pedido {{2}} está pronto.','approved','{"1":"Nara","2":"42"}')`,
      `INSERT INTO message_templates(id,workspace_id,channel_id,group_id,name_human,language_code,body,status) VALUES ('${prefix}-draft','${WORKSPACE}','${prefix}-oficial','${prefix}-draft','rascunho_${tag}','pt_BR','Modelo em elaboração.','draft')`])
    await page.goto(`/${WORKSPACE}/inbox/${prefix}-oficial`)
    await expect(page.getByLabel('Sua resposta')).toBeDisabled()
    await page.getByRole('button', { name: 'Enviar modelo aprovado', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Modelo aprovado')).toBeVisible()
    await expect(dialog.getByLabel('Modelo aprovado').getByRole('option', { name: new RegExp(`rascunho_${tag}`) })).toHaveCount(0)
    await dialog.getByLabel('Modelo aprovado').selectOption(`${prefix}-modelo`)
    await dialog.getByLabel('Variável 1', { exact: true }).fill('Nara')
    await dialog.getByLabel('Variável 2', { exact: true }).fill('42')
    await expect(dialog.getByText('Olá Nara, seu pedido 42 está pronto.', { exact: true })).toBeVisible()
    await page.screenshot({ animations: "disabled", scale: "css", path: resolve(shots, `31-inbox-modelo-${device}.png`) })
    await dialog.getByRole('button', { name: 'Enviar modelo', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('log').getByText('Olá Nara, seu pedido 42 está pronto.', { exact: true })).toBeVisible()
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toMatchObject({ type: 'template', template: { name: `retorno_${tag}`, language: { code: 'pt_BR' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Nara' }, { type: 'text', text: '42' }] }] } })
    await page.reload()
    await expect(page.getByLabel('Sua resposta')).toBeDisabled()
    await expect(page.getByRole('log').getByText('Olá Nara, seu pedido 42 está pronto.')).toBeVisible()
    await page.getByRole('button', { name: 'Enviar modelo aprovado', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ animations: "disabled", scale: "css", path: resolve(shots, `31-inbox-janela-fechada-${device}.png`) })

    await page.goto(`/${WORKSPACE}/inbox/${prefix}-livre`)
    await expect(page.getByLabel('Sua resposta')).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Enviar modelo aprovado', exact: true })).toHaveCount(0)
    await page.getByLabel('Sua resposta').fill('Atendimento pela conexão sem janela.')
    await page.getByRole('button', { name: /^Enviar pelo (WhatsApp|Messenger|Instagram)$/ }).click()
    await expect(page.getByRole('log').getByText('Atendimento pela conexão sem janela.')).toBeVisible()
    expect(calls[1]).toMatchObject({ url: '/send/text', body: { text: 'Atendimento pela conexão sem janela.' } })

    await page.goto(`/${WORKSPACE}/inbox/${prefix}-humano`)
    await expect(page.getByText(/Atendimento humano estendido/)).toBeVisible()
    await expect(page.getByLabel('Sua resposta')).toBeEnabled()
    await page.getByLabel('Sua resposta').fill('Seguimos com a orientação solicitada.')
    await page.getByRole('button', { name: /^Enviar pelo (WhatsApp|Messenger|Instagram)$/ }).click()
    await expect(page.getByRole('log').getByText('Seguimos com a orientação solicitada.')).toBeVisible()
    expect(calls[2].body).toMatchObject({ tag: 'HUMAN_AGENT', message: { text: 'Seguimos com a orientação solicitada.' } })
    await page.getByLabel('Sua resposta').scrollIntoViewIfNeeded()
    await page.screenshot({ animations: "disabled", scale: "css", path: resolve(shots, `31-inbox-janela-humana-${device}.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally {
    await new Promise<void>(ok => server.close(() => ok()))
    sql([`DELETE FROM messages WHERE workspace_id='${WORKSPACE}' AND conversation_id LIKE '${prefix}%'`, `DELETE FROM conversations WHERE workspace_id='${WORKSPACE}' AND id LIKE '${prefix}%'`, `DELETE FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND contact_id LIKE '${prefix}%'`, `DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id LIKE '${prefix}%'`, `DELETE FROM channels WHERE workspace_id='${WORKSPACE}' AND id LIKE '${prefix}%'`])
  }
})
