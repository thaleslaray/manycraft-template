import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { test, expect } from './fixtures'
import { api, consulta, ENGINE, novoTag, q, sql, WORKSPACE, FOTO_PNG, pastaPrints, abrirMaisBlocos } from './helpers'

test('card e galeria: editar, reordenar, persistir, publicar e enviar no Graph falso; conexão incompatível bloqueia', { tag: "@celular" }, async ({ page }, info) => {
  const tag = novoTag(), automation = `e2e-cards-${tag}`, unsupported = `e2e-cards-no-${tag}`
  let connection = `e2e-cards-yes-${tag}`
  const calls: Record<string, any>[] = []
  let server: ReturnType<typeof createServer> | undefined
  const card = { title: 'Oficina de criação', subtitle: 'Oficina para {{primeiro_nome|você}}', imageUrl: `${ENGINE}/e2e-image.png`, actionUrl: 'https://example.test/oficina', buttons: [{ type: 'url', title: 'Conhecer', url: 'https://example.test/oficina' }] }
  const blocks = info.project.name === 'mobile' ? [{ kind: 'card', aspectRatio: 'horizontal', cards: [card] }, { kind: 'gallery', aspectRatio: 'square', cards: [{ ...card, title: 'Oficina avançada' }, card] }] : [{ kind: 'text', text: 'Conheça nossas oficinas.' }]
  const graph = { nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'm', type: 'message', position: { x: 380, y: 0 }, config: { blocks } }], edges: [{ from: 't', port: 'next', to: 'm' }] }
  const directory = pastaPrints("clone-screens")
  // Routine checks must not rewrite the committed visual evidence.
  const capture = async (name: string) => {
    if (process.env.E2E_CAPTURE_CARDS !== '1') return
    mkdirSync(directory, { recursive: true })
    await page.screenshot({ path: `${directory}/${name}.png`, scale: 'css' })
  }
  try {
    if (info.project.name === 'desktop') {
      const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
      expect(catalog.development).toBeTruthy()
      const base = new URL(catalog.development!.providerApiBase); expect(['localhost', '127.0.0.1']).toContain(base.hostname)
      // Sobra de uma execução interrompida deixa a conta falsa conectada e o motor recusa duplicar (409).
      sql([`DELETE FROM channels WHERE type='instagram' AND external_id='1234567' AND display_name='Vitrine de oficinas'`])
      server = createServer(async (req, res) => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
        // Chamadas de manutenção do provedor (assinar a conta, sem corpo; assinar o webhook do app, em formulário) não entram na lista: só as mensagens (JSON).
        const raw = Buffer.concat(chunks).toString()
        if (req.method === 'POST' && raw.trim() && req.headers['content-type']?.includes('application/json')) calls.push(JSON.parse(raw))
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(req.method === 'POST' ? { message_id: `fake-${calls.length}`, recipient_id: '424242' } : { id: '1234567', user_id: '1234567', username: 'vitrine_falsa', name: 'Ana Teste' }))
      })
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(Number(base.port), base.hostname, resolve) })
      const created = await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'instagram', displayName: 'Vitrine de oficinas', credentials: { accountId: '1234567', accessToken: 'E2E-CARDS-ONLY', appSecret: 'e2e-cards-secret' } }) })
      connection = created.connection.id
      // Fixture represents a connection whose manual webhook setup is already complete.
      sql([`UPDATE channels SET connection_state='connected',status_detail=NULL WHERE id='${connection}'`])
    } else {
      sql([`INSERT INTO channels(id,workspace_id,type,provider,external_id,status,display_name) VALUES ('${connection}','${WORKSPACE}','instagram','instagram_unified','${connection}','connected','Vitrine de oficinas')`])
    }
    sql([
      `INSERT INTO channels(id,workspace_id,type,external_id,status,display_name) VALUES ('${unsupported}','${WORKSPACE}','telegram','${unsupported}','connected','Atendimento sem vitrine')`,
      `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${automation}','${WORKSPACE}','Catálogo de oficinas','${q(JSON.stringify(graph))}')`,
      `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('${automation}-t','${WORKSPACE}','${automation}','${connection}','Pedido de catálogo','keyword','active','every_time','{"node_id":"t"}')`,
      `INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('${automation}-k','${WORKSPACE}','${automation}-t','is','["catalogo-${tag}"]','live',0)`,
    ])
    await page.route('**/e2e-image.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(FOTO_PNG.split(',')[1], 'base64') }))
    await page.setViewportSize({ width: info.project.name === 'desktop' ? 1440 : 390, height: info.project.name === 'desktop' ? 900 : 844 })
    await page.goto(`/${WORKSPACE}/automations/${automation}`)
    if (info.project.name === 'mobile') {
      await expect(page.getByRole('list', { name: 'Passos da automação' })).toContainText('Galeria')
      await expect(page.getByLabel('Prévia do card')).toBeVisible()
      await page.getByLabel('Prévia do card').scrollIntoViewIfNeeded()
      await capture('07-card-mobile')
      await page.getByLabel('Prévia da galeria').scrollIntoViewIfNeeded()
      await capture('07-galeria-mobile')
      return
    }
    const node = page.locator('.react-flow__node[data-id="m"]'); await node.click()
    await abrirMaisBlocos(page)
    await page.getByRole('button', { name: 'Card', exact: true }).click()
    await page.getByLabel('Título do card 1', { exact: true }).fill(card.title)
    await page.getByLabel('Subtítulo do card 1', { exact: true }).fill(card.subtitle)
    // O cartão de prévia é o formulário: imagem, título, subtítulo e botões no lugar; links só na configuração do toque.
    await expect(page.getByRole('textbox', { name: 'Link ao tocar no card 1' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Imagem do card 1', exact: true }).click()
    await page.getByLabel('Imagem do card 1 (URL)', { exact: true }).fill(card.imageUrl)
    await page.getByRole('button', { name: 'Configurar toque do card 1', exact: true }).click()
    await page.getByLabel('Link ao tocar no card 1', { exact: true }).fill(card.actionUrl)
    await page.getByRole('button', { name: 'Adicionar botão ao card 1', exact: true }).click()
    await page.getByLabel('Título do botão 1 do card 1', { exact: true }).fill('Conhecer')
    await page.getByRole('button', { name: 'Configurar toque do botão 1 do card 1', exact: true }).click()
    await page.getByLabel('Link do botão 1 do card 1', { exact: true }).fill(card.actionUrl)
    await expect(node).not.toContainText('example.test')
    await capture('07-card-desktop')
    await abrirMaisBlocos(page)
    await page.getByRole('button', { name: 'Galeria', exact: true }).click()
    const gallery = page.getByRole('list', { name: 'Blocos da mensagem' }).getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Galeria', exact: true }) }).first()
    await gallery.getByLabel('Título do card 1', { exact: true }).fill('Oficina inicial')
    await gallery.getByRole('button', { name: /Adicionar card/ }).click()
    await gallery.getByLabel('Título do card 2', { exact: true }).fill('Oficina avançada')
    await gallery.getByRole('button', { name: 'Mover card 2 para trás', exact: true }).click()
    await expect(gallery.getByLabel('Título do card 1', { exact: true })).toHaveValue('Oficina avançada')
    await expect(gallery.getByRole('radiogroup', { name: 'Proporção da imagem' })).toBeVisible()
    await gallery.getByRole('radio', { name: 'Quadrada', exact: true }).click()
    await expect(node.getByLabel('Prévia da galeria')).toContainText('Card 1 de 2')
    await node.getByRole('button', { name: 'Próximo card', exact: true }).click()
    await expect(node.getByLabel('Prévia da galeria')).toContainText('Card 2 de 2')
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByText('Rascunho salvo', { exact: true })).toBeVisible()
    await page.reload(); await node.click()
    const stored = consulta<{ draft_graph: string }>(`SELECT draft_graph FROM automations WHERE id='${automation}'`)[0]
    expect(JSON.parse(stored.draft_graph).nodes[1].config.blocks[2]).toMatchObject({ kind: 'gallery', aspectRatio: 'square', cards: [{ title: 'Oficina avançada' }, { title: 'Oficina inicial' }] })
    await page.getByRole('heading', { name: 'Galeria', exact: true }).scrollIntoViewIfNeeded()
    await capture('07-galeria-desktop')
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Publicada · versão 1', { exact: true })).toBeVisible()
    const payload = JSON.stringify({ object: 'instagram', entry: [{ id: '1234567', messaging: [{ sender: { id: '424242' }, recipient: { id: '1234567' }, timestamp: Date.now(), message: { mid: `cards-${tag}`, text: `catalogo-${tag}` } }] }] })
    const response = await fetch(`${ENGINE}/api/hooks/${connection}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'e2e-cards-secret').update(payload).digest('hex')}` }, body: payload })
    expect(response.status).toBe(200)
    await expect.poll(() => calls.filter(c => c.message?.attachment?.payload.template_type === 'generic').length, { timeout: 30000 }).toBe(2)
    expect(calls.filter(c => c.message?.attachment).map(c => c.message.attachment.payload)).toEqual([expect.objectContaining({ image_aspect_ratio: 'horizontal', elements: [expect.objectContaining({ title: card.title, subtitle: 'Oficina para Ana', default_action: { type: 'web_url', url: card.actionUrl } })] }), expect.objectContaining({ image_aspect_ratio: 'square', elements: [expect.objectContaining({ title: 'Oficina avançada' }), expect.objectContaining({ title: 'Oficina inicial' })] })])
    // O passo carrega o próprio canal: para a vitrine ficar incompatível, o passo e o gatilho passam para o Telegram.
    sql([`UPDATE triggers SET channel_id='${unsupported}' WHERE automation_id='${automation}'`, `UPDATE automations SET draft_graph=replace(draft_graph,'"channel":"instagram"','"channel":"telegram"') WHERE id='${automation}'`])
    await page.reload(); await page.getByRole('button', { name: 'Editar', exact: true }).first().click(); await node.click()
    await abrirMaisBlocos(page)
    await expect(page.getByRole('button', { name: 'Card', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Galeria', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Atendimento sem vitrine' })).toBeVisible()
    const refused = await fetch(`${ENGINE}/api/automations/${automation}/publish`, { method: 'POST', headers: { 'x-workspace': WORKSPACE } })
    expect(refused.status).toBe(409); expect(await refused.text()).toContain('Atendimento sem vitrine')
    await capture('07-galeria-incompativel-desktop')
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
    sql([`DELETE FROM contacts WHERE id IN (SELECT contact_id FROM contact_channels WHERE channel_id='${connection}')`, `DELETE FROM automations WHERE id='${automation}'`, `DELETE FROM channels WHERE id IN ('${connection}','${unsupported}')`])
  }
})
