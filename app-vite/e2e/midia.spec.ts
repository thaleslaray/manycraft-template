import { mkdirSync } from 'node:fs'
import { test, expect } from './fixtures'
import { api, canalE2eSql, ENGINE, FOTO_PNG, novoTag, q, sql, WORKSPACE, pastaPrints } from './helpers'
import { subirTelegramFalso } from './telegram-falso'

test('mídia: anexar, persistir e enviar foto pelo Telegram falso; ficha limita tamanho e publicação', { tag: "@celular" }, async ({ page }, info) => {
  const tag = novoTag(), automation = `e2e-media-${tag}`
  let connection = `e2e-media-channel-${tag}`
  let fake: Awaited<ReturnType<typeof subirTelegramFalso>> | undefined
  const graph = { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'photo', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [{ kind: 'media', media: 'image', url: '', name: 'Produto.png' }] } },
  ], edges: [{ from: 'trigger', port: 'next', to: 'photo' }] }
  try {
    if (info.project.name === 'desktop') {
      const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
      expect(catalog.development).toBeTruthy()
      const base = new URL(catalog.development!.providerApiBase)
      expect(['127.0.0.1', 'localhost']).toContain(base.hostname)
      fake = await subirTelegramFalso(Number(base.port), { '9912345:E2E-media': { id: 9912345, username: 'media_bot' } })
      connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', credentials: { botToken: '9912345:E2E-media' } }) })).connection.id
    } else {
      sql(canalE2eSql(connection))
      const saved = await api<{ id: string; url: string; mime: string; size: number }>(`/api/media?connection_id=${connection}&media=image`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from(FOTO_PNG.split(',')[1], 'base64') })
      Object.assign(graph.nodes[1].config.blocks![0], { url: saved.url, mediaId: saved.id, mime: saved.mime, size: saved.size })
    }
    sql([
      `INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('media-url-${tag}','${WORKSPACE}','Imagem do produto ${tag}','text')`,
      `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${automation}','${WORKSPACE}','Vitrine de produtos','${q(JSON.stringify(graph))}')`,
      `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('${automation}-trigger','${WORKSPACE}','${automation}','${connection}','Pedido de produto','keyword','active','every_time','{"node_id":"trigger"}')`,
      `INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('${automation}-keyword','${WORKSPACE}','${automation}-trigger','is','["media-${tag}"]','live',0)`,
    ])
    await page.setViewportSize({ width: info.project.name === 'desktop' ? 1440 : 390, height: info.project.name === 'desktop' ? 900 : 844 })
    await page.goto(`/${WORKSPACE}/automations/${automation}`)
    const dir = pastaPrints("clone-screens")
    mkdirSync(dir, { recursive: true })
    if (info.project.name === 'mobile') {
      await expect(page.getByRole('list', { name: 'Passos da automação' })).toContainText('Imagem')
      await expect.poll(() => page.getByAltText('Prévia da imagem').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
      await page.screenshot({ path: `${dir}/06-midia-mobile.png`, scale: 'css' })
      return
    }
    const node = page.locator('.react-flow__node[data-id="photo"]')
    await node.click()
    await expect(page.getByText('Anexe um arquivo ou informe uma URL.')).toBeVisible()
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(node.getByRole('img', { name: /^Erro:/ })).toBeVisible()
    let finishUpload!: () => void
    const uploadGate = new Promise<void>(resolve => { finishUpload = resolve })
    await page.route('**/api/media?*', async route => { const response = await route.fetch(); await uploadGate; await route.fulfill({ response }) })
    const upload = page.getByLabel('Enviar arquivo de Imagem')
    await upload.setInputFiles({ name: 'produto.png', mimeType: 'image/png', buffer: Buffer.from(FOTO_PNG.split(',')[1], 'base64') })
    await expect(page.getByText('Enviando arquivo…')).toBeVisible()
    await page.getByRole('button', { name: 'Texto', exact: true }).click()
    await page.getByRole('textbox', { name: 'Texto do bloco 2', exact: true }).fill('Conheça o produto da semana.')
    finishUpload()
    await expect(page.getByAltText('Prévia da imagem').first()).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Texto do bloco 2', exact: true })).toHaveValue('Conheça o produto da semana.')
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByText('Rascunho salvo', { exact: true })).toBeVisible()
    await page.reload(); await node.click()
    await expect(page.getByAltText('Prévia da imagem').first()).toBeVisible()
    await page.locator('.react-flow__controls-fitview').click()
    await page.screenshot({ path: `${dir}/06-midia-desktop.png`, scale: 'css' })
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Publicada · versão 1', { exact: true })).toBeVisible()
    const hook = fake!.webhook()!
    const user = 7900000 + Math.floor(Math.random() * 100000)
    const incoming = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token }, body: JSON.stringify({ update_id: Date.now(), message: { message_id: 1, from: { id: user, first_name: 'Ana' }, chat: { id: user, type: 'private' }, text: `media-${tag}` } }) })
    expect(incoming.status).toBe(200)
    await expect.poll(() => fake!.chamadas.find(c => c.metodo === 'sendPhoto')?.corpo, { timeout: 30000 }).toMatchObject({ chat_id: String(user), photo: expect.stringMatching(/\/api\/media\/public\//) })
    // A foto sai logo; o texto da mesma mensagem espera ~1 s pelo limite de 1 envio por segundo da conversa. Mudar o limite da conexão
    // antes disso faz a nova tentativa do texto reajustar a mensagem inteira ao perfil novo e a execução falhar: espera a execução terminar.
    await expect.poll(async () => (await api<{ nodes: Record<string, { sent: number }> }>(`/api/automations/${automation}/stats`)).nodes.photo?.sent, { timeout: 30000 }).toBe(1)
    sql([`UPDATE channels SET capabilities_override='{"media":{"image":{"maxBytes":32}}}' WHERE id='${connection}'`])
    await page.reload()
    await page.getByRole('button', { name: 'Editar', exact: true }).first().click(); await node.click()
    await expect(page.getByRole('list', { name: 'Blocos da mensagem' }).locator('.border-danger')).toHaveCount(1)
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(node.getByRole('img', { name: /^Erro:/ })).toBeVisible()
    await expect(page.getByText('Até 32 bytes · image/jpeg, image/png', { exact: true })).toBeVisible()
    await page.locator('.react-flow__controls-fitview').click()
    await page.screenshot({ path: `${dir}/06-midia-limite-desktop.png`, scale: 'css' })
    const refused = await fetch(`${ENGINE}/api/automations/${automation}/publish`, { method: 'POST', headers: { 'x-workspace': WORKSPACE } })
    expect(refused.status).toBe(409)
    sql([`UPDATE channels SET capabilities_override=NULL WHERE id='${connection}'`])
    await page.reload()
    await page.getByRole('button', { name: 'Editar', exact: true }).first().click(); await node.click()
    const originalUrl = String(fake!.chamadas.find(c => c.metodo === 'sendPhoto')!.corpo.photo)
    const block = page.getByRole('list', { name: 'Blocos da mensagem' }).getByRole('listitem').first()
    await block.getByRole('textbox', { name: 'URL da mídia', exact: true }).fill('')
    await block.getByRole('button', { name: 'Inserir variável', exact: true }).click()
    const picker = block.getByRole('group', { name: 'Inserir variável', exact: true })
    await picker.getByLabel('Campo', { exact: true }).selectOption('campo:media-url-' + tag)
    await picker.getByRole('textbox', { name: 'Texto de reserva', exact: true }).fill(originalUrl)
    await picker.getByRole('button', { name: 'Inserir no texto', exact: true }).click()
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Publicada · versão 2', { exact: true })).toBeVisible()
    const variableIncoming = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token }, body: JSON.stringify({ update_id: Date.now(), message: { message_id: 2, from: { id: user, first_name: 'Ana' }, chat: { id: user, type: 'private' }, text: `media-${tag}` } }) })
    expect(variableIncoming.status).toBe(200)
    await expect.poll(() => fake!.chamadas.filter(c => c.metodo === 'sendPhoto').map(c => c.corpo.photo), { timeout: 30000 }).toEqual([originalUrl, originalUrl])
    await expect.poll(async () => (await api<{ nodes: Record<string, { sent: number }> }>(`/api/automations/${automation}/stats`)).nodes.photo?.sent, { timeout: 30000 }).toBe(2)
  } finally {
    await fake?.fechar()
    sql([`DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT contact_id FROM contact_channels WHERE channel_id='${connection}')`, `DELETE FROM automations WHERE id='${automation}'`, `DELETE FROM channels WHERE id='${connection}'`, `DELETE FROM custom_fields WHERE id='media-url-${tag}'`])
  }
})
