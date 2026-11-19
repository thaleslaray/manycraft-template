import { test, expect } from './fixtures'
import { ENGINE, WORKSPACE, api, consulta, novoTag, q, sql, caminhoPrint, escolher, escolherAutomacao, menuMais } from './helpers'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'

test('Basic publica menu e perguntas, preserva ordem e dispara a automação pelo provedor falso', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(150_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'Somente transporte falso local').toBeTruthy()
  const base = new URL(catalog.development!.providerApiBase)
  expect(['localhost', '127.0.0.1']).toContain(base.hostname)
  const tag = novoTag(), account = `${Date.now()}`, secret = `falso-${tag}`, name = `Oficina local ${tag}`
  const configurations: { method: string; body: any }[] = [], sent: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      const url = new URL(req.url!, base)
      let result: unknown = { first_name: 'Pessoa', last_name: 'Local' }
      if (url.pathname.endsWith('/me')) result = { id: account, name }
      if (url.pathname.endsWith('/messenger_profile')) { configurations.push({ method: req.method!, body }); result = { result: 'success' } }
      if (url.pathname.endsWith('/messages')) { sent.push(body.message.text); result = { message_id: `m-${sent.length}`, recipient_id: body.recipient.id } }
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(result))
    })
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(Number(base.port), '127.0.0.1', done) })
  let connection = ''; const automations: string[] = []
  const route = (kind: string) => `/api/basic/${connection}/surfaces/${kind}`
  try {
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'messenger', displayName: name, credentials: { accessToken: `local-${tag}`, pageId: account, appSecret: secret } }) })).connection.id
    for (const [title, text] of [['Informações', 'Estes são nossos horários.'], ['Cursos', 'Veja os cursos disponíveis.']]) {
      const id = (await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: `${title} ${tag}` }) })).id
      automations.push(id)
      await api(`/api/automations/${id}/draft`, { method: 'PUT', body: JSON.stringify({ graph: {
        nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'm', type: 'message', position: { x: 300, y: 0 }, config: { blocks: [{ kind: 'text', text }] } }], edges: [{ from: 't', port: 'next', to: 'm' }],
      } }) })
      await api(`/api/automations/${id}/publish`, { method: 'POST' })
    }
    await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/basic`)
    await expect(page.getByRole('region', { name: '@marina_assistente_pessoal_bot', exact: true }).getByRole('button', { name: 'Configurar menu principal', exact: true })).toHaveCount(0)
    const conta = page.getByRole('region', { name, exact: true })
    // Ainda sem configuração, a linha oferece "Configurar"; depois de salva, "Editar configuração" fica no ⋮. O teste sabe em qual dos dois está.
    async function open(title: string, configurado: boolean) {
      if (configurado) {
        await expect(conta.getByRole('button', { name: `Configurar ${title}`, exact: true })).toHaveCount(0)
        await menuMais(page, conta.getByRole('button', { name: `Mais ações de ${title}`, exact: true }), 'Editar configuração')
      } else await conta.getByRole('button', { name: `Configurar ${title}`, exact: true }).click()
      await expect(page.getByRole('dialog').getByRole('status')).toBeVisible()
    }
    async function fill(index: number, title: string, automation: string) {
      await page.getByRole('textbox', { name: `Título do item ${index}`, exact: true }).fill(title)
      await escolherAutomacao(page, page.getByRole('region', { name: `Item ${index}`, exact: true }), `${['Informações', 'Cursos'][automations.indexOf(automation)]} ${tag}`, `Automação do item ${index}`)
    }
    async function save(label: string, method = 'PUT') {
      const saved = page.waitForResponse(r => r.request().method() === method && r.url().includes('/surfaces/'))
      await page.getByRole('button', { name: label, exact: true }).click()
      expect((await saved).status()).toBe(200)
    }
    async function capture(suffix: string) {
      const path = caminhoPrint(`clone-screens/repintura/06-${suffix}-${info.project.name}.png`)
      const dialog = page.getByRole('dialog')
      if (await dialog.isVisible()) await dialog.evaluate(element => { element.scrollTop = 0 })
      await page.screenshot({ path, scale: 'css', animations: 'disabled' })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await expect(page.locator('select')).toHaveCount(0)
    await expect(conta.getByRole('region', { name: 'Menu principal', exact: true }).getByRole('button', { name: 'Configurar menu principal', exact: true })).toBeVisible()
    await conta.getByRole('region', { name: 'Menu principal', exact: true }).scrollIntoViewIfNeeded()
    await capture('basico')
    await open('menu principal', false)
    await expect(page.getByRole('group', { name: 'Ações do painel' })).toBeInViewport()
    await page.getByRole('button', { name: 'Adicionar item', exact: true }).click(); await fill(1, 'Informações', automations[0])
    await page.getByRole('button', { name: 'Adicionar item', exact: true }).click(); await fill(2, 'Cursos', automations[1])
    await page.getByRole('button', { name: 'Mais ações de item 2', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Subir', exact: true }).click()
    // arrastar pela alça reordena
    await page.getByRole('button', { name: 'Arrastar item 1', exact: true }).dragTo(page.getByRole('region', { name: 'Item 2', exact: true }))
    await expect(page.getByRole('textbox', { name: 'Título do item 1', exact: true })).toHaveValue('Informações')
    await page.getByRole('button', { name: 'Arrastar item 1', exact: true }).dragTo(page.getByRole('region', { name: 'Item 2', exact: true }))
    await expect(page.getByRole('textbox', { name: 'Título do item 1', exact: true })).toHaveValue('Cursos')
    // prévia do menu: lista aberta pelo ícone de menu
    await page.getByRole('button', { name: 'Abrir menu', exact: true }).click()
    await expect(page.getByRole('list', { name: 'Itens do menu' }).getByRole('listitem')).toHaveText(['Cursos', 'Informações'])
    await page.getByRole('switch', { name: 'Ativado' }).click()
    await save('Salvar rascunho')
    await expect(page.getByRole('status')).toHaveText('Rascunho salvo')
    expect(configurations).toHaveLength(0)
    await page.getByRole('button', { name: 'Fechar', exact: true }).first().click()
    await page.reload()
    await open('menu principal', true)
    await expect(page.getByRole('textbox', { name: 'Título do item 1', exact: true })).toHaveValue('Cursos')
    await save('Atualizar menu', 'POST'); await expect(page.getByRole('status')).toHaveText('Publicado')
    expect(configurations[0].body.persistent_menu[0].call_to_actions.map((item: any) => item.title)).toEqual(['Cursos', 'Informações'])
    await page.getByRole('button', { name: 'Abrir menu', exact: true }).click()
    await capture('menu')
    const config = await api<{ published: { items: { payload: string }[] } }>(route('main_menu'))
    const body = JSON.stringify({ object: 'page', entry: [{ id: account, messaging: [{ sender: { id: `${Number(account) + 1}` }, recipient: { id: account }, timestamp: Date.now(), postback: { mid: `click-${tag}`, payload: config.published.items[0].payload } }] }] })
    const hook = await fetch(`${ENGINE}/api/hooks/${connection}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }, body })
    expect(hook.status).toBe(200)
    await expect.poll(() => sent, { timeout: 30_000 }).toEqual(['Veja os cursos disponíveis.'])
    await page.getByRole('button', { name: 'Fechar', exact: true }).first().click(); await open('iniciadores de conversa', false)
    for (let index = 1; index <= 4; index++) {
      await page.getByRole('button', { name: 'Adicionar pergunta', exact: true }).click()
      await fill(index, ['Quais são os horários?', 'Como participar?', 'Onde fica a oficina?', 'Quais cursos vocês oferecem?'][index - 1], automations[index === 4 ? 1 : 0])
    }
    await expect(page.getByRole('button', { name: 'Adicionar pergunta', exact: true })).toBeDisabled()
    await page.getByRole('switch', { name: 'Ativado' }).click()
    await save('Publicar perguntas', 'POST'); await expect(page.getByRole('status')).toHaveText('Publicado')
    expect(configurations.at(-1)?.body.ice_breakers).toHaveLength(4)
    await capture('iniciadores')
    await page.getByRole('button', { name: 'Fechar', exact: true }).first().click()
    await page.reload()
    await open('iniciadores de conversa', true)
    await expect(page.getByRole('textbox', { name: 'Título do item 1', exact: true })).toHaveValue('Quais são os horários?')
    await page.getByRole('button', { name: 'Mais ações de item 4', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Remover', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Adicionar pergunta', exact: true })).toBeEnabled()
    await page.getByRole('switch', { name: 'Ativado' }).click(); await save('Publicar perguntas', 'POST')
    expect(configurations.at(-1)).toMatchObject({ method: 'DELETE', body: { fields: ['ice_breakers'] } })
    expect(consulta<{ n: number }>(`SELECT count(*) n FROM surface_firings WHERE connection_id='${q(connection)}'`)[0].n).toBe(1)
  } finally {
    await new Promise<void>(done => server.close(() => done()))
    if (connection) sql([
      `DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT contact_id FROM contact_channels WHERE channel_id='${q(connection)}')`,
      `DELETE FROM inbound_events WHERE channel_id='${q(connection)}'`, `DELETE FROM channels WHERE id='${q(connection)}'`,
    ])
    if (automations.length) sql(automations.map(id => `DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(id)}'`))
  }
})
