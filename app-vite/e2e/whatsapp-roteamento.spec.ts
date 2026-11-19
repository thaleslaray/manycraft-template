import { createServer } from 'node:http'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from './fixtures'
import { WORKSPACE, api, sql, q, novoTag, pastaPrints } from './helpers'
import { encryptCredentials } from '../../engine/src/channels/core/crypto'

// API oficial do WhatsApp com mais de um parceiro no número (Conversation Routing) e conversa iniciada pela caixa de entrada.
// Graph API falsa local: nada sai da máquina.
test('whatsapp oficial: papéis do Conversation Routing na conexão e conversa iniciada com modelo para número novo', { tag: "@celular" }, async ({ page }, info) => {
  const tag = novoTag(), id = `e2e-rota-${tag}`, phoneId = String(700000 + Math.floor(Math.random() * 299999))   // external_id é único por tipo
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'O ambiente local precisa de DEV_PROVIDER_API_BASE (Graph API falsa)').toBeTruthy()
  const base = catalog.development!.providerApiBase
  expect(new URL(base).hostname).toBe('127.0.0.1')
  const vars = readFileSync(resolve(import.meta.dirname, '../../engine/.dev.vars'), 'utf8')
  const version = vars.match(/^CONNECTIONS_KEK_ACTIVE=["']?(\d+)/m)![1]
  const key = vars.match(new RegExp(`^CONNECTIONS_KEK_V${version}=["']?([^\\r\\n"']+)`, 'm'))![1]
  const sealed = await encryptCredentials({ CONNECTIONS_KEK_ACTIVE: version, [`CONNECTIONS_KEK_V${version}`]: key }, { workspaceId: WORKSPACE, connectionId: id },
    { accessToken: 'TESTONLY', phoneNumberId: phoneId, wabaId: '456' })
  const calls: { method: string; url: string; body: Record<string, any> }[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      calls.push({ method: req.method ?? '', url: req.url ?? '', body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} })
      res.setHeader('content-type', 'application/json')
      if (req.url?.endsWith(`/${phoneId}/routing_roles`)) return res.end(JSON.stringify({ roles: ['customer_service', 'escalation'], is_standby: false }))
      if (req.url?.endsWith(`/${phoneId}/messages`)) return res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: '5511999990001', wa_id: '5511999990001' }], messages: [{ id: `wamid.FALSO${calls.length}` }] }))
      res.statusCode = 404; res.end('{}')
    })
  })
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(Number(new URL(base).port), '127.0.0.1', ok) })
  const shots = pastaPrints("prontidao")
  mkdirSync(shots, { recursive: true })
  const device = info.project.name === 'desktop' ? 'desktop' : 'mobile'
  await page.setViewportSize(device === 'desktop' ? { width: 1280, height: 1000 } : { width: 390, height: 1100 })
  try {
    sql([`INSERT INTO channels(id,workspace_id,type,provider,external_id,status,connection_state,display_name,settings,credentials_ciphertext,credentials_iv,credentials_key_version) VALUES ('${id}','${WORKSPACE}','whatsapp','meta_whatsapp_cloud','${phoneId}','connected','connected','Oficina Horizonte ${tag}','${q(JSON.stringify({ apiBase: base }))}','${sealed.ciphertext}','${sealed.iv}',${sealed.keyVersion})`,
      `INSERT INTO message_templates(id,workspace_id,channel_id,group_id,name_human,language_code,body,status) VALUES ('${id}-modelo','${WORKSPACE}','${id}','${id}-grupo','aviso_${tag}','pt_BR','Passando para avisar que seu pedido está a caminho.','approved')`])

    // (c) a tela da conexão mostra os papéis do nosso app e explica o erro 131070
    await page.goto(`/${WORKSPACE}/settings/channels`)
    const card = page.getByRole('listitem').filter({ hasText: `Oficina Horizonte ${tag}` }).getByRole('region', { name: `Roteamento de conversas de Oficina Horizonte ${tag}`, exact: true })
    await expect(card.getByText('Atendimento (conversas iniciadas pelo cliente)')).toBeVisible()
    await expect(card.getByText(/Parceiro de escalonamento/)).toBeVisible()
    await card.getByText(/Erro 131070/).click()
    await expect(card.getByText(/Gerenciador de Negócios, vá em Contas do WhatsApp, escolha o número e abra Roteamento de conversas/)).toBeVisible()
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ animations: 'disabled', scale: 'css', path: resolve(shots, `01-conexao-routing-${device}.png`) })
    expect(calls.some(c => c.method === 'GET' && c.url.endsWith(`/${phoneId}/routing_roles`))).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    // (e) conversa nova com um número que nunca escreveu: modelo aprovado, consentimento confirmado
    await page.goto(`/${WORKSPACE}/inbox`)
    // A ação fica na barra do topo; no celular ela vira item do menu ⋮.
    const novaConversa = page.getByRole('banner').getByRole('button', { name: 'Nova conversa', exact: true })
    await expect(novaConversa.or(page.getByRole('banner').getByRole('button', { name: 'Mais ações' }))).toBeVisible()
    if (await novaConversa.isVisible()) await novaConversa.click()
    else { await page.getByRole('banner').getByRole('button', { name: 'Mais ações' }).click(); await page.getByRole('menuitem', { name: 'Nova conversa' }).click() }
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel("Telefone com código do país e DDD")).toBeVisible()   // o diálogo termina de carregar as conexões antes de contar
    const numero = dialog.getByLabel('Número que envia')   // só aparece com mais de uma conexão oficial; com outra conexão antes na lista, o diálogo abre no modo dela
    if (await numero.count()) await numero.selectOption(id)
    await expect(dialog.getByLabel('Modelo aprovado')).toBeVisible()
    await dialog.getByLabel('Telefone com código do país e DDD').fill('+55 (11) 99999-0001')
    await dialog.getByLabel(/Nome/).fill('Pessoa Nova')
    await dialog.getByLabel('Modelo aprovado').selectOption(`${id}-modelo`)
    await expect(dialog.getByRole('button', { name: 'Enviar modelo', exact: true })).toBeDisabled()   // falta confirmar o consentimento
    await dialog.getByLabel(/Confirmo que esta pessoa aceitou/).check()
    await page.screenshot({ animations: 'disabled', scale: 'css', path: resolve(shots, `02-nova-conversa-${device}.png`) })
    await dialog.getByRole('button', { name: 'Enviar modelo', exact: true }).click()
    await expect(page.getByRole('log').getByText('Passando para avisar que seu pedido está a caminho.')).toBeVisible()
    await page.screenshot({ animations: 'disabled', scale: 'css', path: resolve(shots, `03-conversa-iniciada-${device}.png`) })
    const envio = calls.find(c => c.method === 'POST' && c.url.endsWith(`/${phoneId}/messages`))!
    expect(envio.body).toMatchObject({ messaging_product: 'whatsapp', to: '5511999990001', type: 'template', template: { name: `aviso_${tag}`, language: { code: 'pt_BR' } } })
    expect(envio.body.recipient).toBeUndefined()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally {
    await new Promise<void>(ok => server.close(() => ok()))
    sql([`DELETE FROM messages WHERE workspace_id='${WORKSPACE}' AND conversation_id IN (SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.id=v.contact_channel_id WHERE cc.channel_id='${id}')`,
      `DELETE FROM conversations WHERE workspace_id='${WORKSPACE}' AND contact_channel_id IN (SELECT id FROM contact_channels WHERE channel_id='${id}')`,
      `DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT contact_id FROM contact_channels WHERE channel_id='${id}')`,
      `DELETE FROM whatsapp_numbers WHERE workspace_id='${WORKSPACE}' AND first_connection_id='${id}'`,
      `DELETE FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND channel_id='${id}'`,
      `DELETE FROM message_templates WHERE workspace_id='${WORKSPACE}' AND channel_id='${id}'`,
      `DELETE FROM channels WHERE workspace_id='${WORKSPACE}' AND id='${id}'`])
  }
})
