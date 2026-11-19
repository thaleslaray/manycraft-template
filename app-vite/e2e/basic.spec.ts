import { test, expect } from './fixtures'
import { ENGINE, WORKSPACE, api, consulta, novoTag, q, sql, caminhoPrint, escolher, escolherAutomacao, menuMais } from './helpers'
import { subirTelegramFalso, type TelegramFalso } from './telegram-falso'

test('Basic configura conexão, prévia e frequência; Telegram falso recebe boas-vindas e resposta padrão', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(150_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'O transporte precisa ser falso local').toBeTruthy()
  const tag = novoTag(), bot = 9_000_000 + Math.floor(Math.random() * 900_000)
  const token = `${bot}:e2e-${tag}`, name = `Recepção local ${tag}`
  let fake: TelegramFalso | undefined, connection: string | undefined
  const automations: string[] = []
  try {
    fake = await subirTelegramFalso(Number(new URL(catalog.development!.providerApiBase).port), { [token]: { id: bot, username: `basic_${tag}` } })
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', displayName: name, credentials: { botToken: token } }) })).connection.id
    for (const [title, text] of [['Recepção', 'Olá, esta é sua primeira visita.'], ['Atendimento', 'Recebi sua mensagem e vou ajudar.']]) {
      const id = (await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: `${title} ${tag}` }) })).id
      automations.push(id)
      await api(`/api/automations/${id}/draft`, { method: 'PUT', body: JSON.stringify({ graph: {
        nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'message', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [{ kind: 'text', text }] } }],
        edges: [{ from: 'trigger', port: 'next', to: 'message' }],
      } }) })
      await api(`/api/automations/${id}/publish`, { method: 'POST' })
    }
    await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/basic`)
    const conta = page.getByRole('region', { name, exact: true })
    async function configure(button: string, automation: string, preview: string, daily = false) {
      await conta.getByRole('button', { name: button, exact: true }).click()
      const dialog = page.getByRole('dialog')
      await escolherAutomacao(page, dialog, automation)
      await expect(dialog.getByText(preview, { exact: true })).toBeVisible()
      if (daily) {
        await escolher(page, 'Frequência da resposta', 'Uma vez a cada 24 horas', dialog)
      }
      const toggle = dialog.getByRole('switch', { name: /Ativar / })
      if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click()
      const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/api/basic/'))
      await dialog.getByRole('button', { name: 'Salvar configuração', exact: true }).click()
      expect((await saved).status()).toBe(200)
      await expect(dialog).not.toBeVisible()
    }
    await configure('Configurar boas-vindas', `Recepção ${tag}`, 'Olá, esta é sua primeira visita.')
    await configure('Configurar resposta padrão', `Atendimento ${tag}`, 'Recebi sua mensagem e vou ajudar.', true)
    await page.reload()
    await expect(conta.getByRole('link', { name: `Recepção ${tag}`, exact: true })).toBeVisible()
    await expect(conta.getByText('Uma vez a cada 24 horas', { exact: true })).toBeVisible()
    let update = Date.now(), delivered = 0
    async function deliver(text: string) {
      const hook = fake!.webhook()!, id = ++update
      const response = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token },
        body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: bot + 1, first_name: 'Pessoa local' }, chat: { id: bot + 1, type: 'private' }, text } }) })
      expect(response.status).toBe(200)
      await expect(async () => expect(consulta<{ n: number }>(`SELECT count(*) n FROM inbound_events WHERE channel_id='${q(connection!)}' AND planned_at IS NOT NULL`)[0]?.n).toBe(delivered + 1)).toPass({ timeout: 30_000 })
      delivered++
    }
    await deliver('Olá, primeira mensagem')
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual(['Olá, esta é sua primeira visita.'])
    await deliver('Texto sem palavra-chave')
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual(['Olá, esta é sua primeira visita.', 'Recebi sua mensagem e vou ajudar.'])
    await deliver('Outra dúvida na mesma janela')
    expect(consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs WHERE channel_id='${q(connection)}'`)[0].n).toBe(2)
    await expect(page.locator('select')).toHaveCount(0)
    const resposta = conta.getByRole('region', { name: 'Resposta padrão', exact: true })
    const acao = (item: string) => menuMais(page, resposta.getByRole('button', { name: 'Mais ações de resposta padrão' }), item)
    await expect(resposta.getByText('Ativo', { exact: true })).toBeVisible()
    await expect(resposta.getByRole('link', { name: `Atendimento ${tag}` })).toBeVisible()
    await page.screenshot({ path: caminhoPrint(`clone-screens/repintura/06-basico-${info.project.name}.png`), scale: 'css', animations: 'disabled' })
    // X troca a automação ligada pelo pop-up Escolher existente
    await acao('Trocar automação')
    const janelaEscolha = page.getByRole('dialog', { name: 'Escolher automação existente', exact: true })
    await expect(janelaEscolha.getByRole('region', { name: 'Prévia' })).toBeVisible()
    await page.screenshot({ path: caminhoPrint(`clone-screens/repintura/06-janelaEscolha-existente-${info.project.name}.png`), scale: 'css', animations: 'disabled' })
    await janelaEscolha.getByRole('combobox', { name: 'Buscar automação' }).fill(`Recepção ${tag}`)
    await janelaEscolha.getByRole('option', { name: new RegExp(`Recepção ${tag}`) }).click()
    const trocou = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/api/basic/'))
    await janelaEscolha.getByRole('button', { name: 'Escolher', exact: true }).click()
    expect((await trocou).status()).toBe(200)
    await expect(resposta.getByRole('link', { name: `Recepção ${tag}` })).toBeVisible()
    const volta = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/api/basic/'))
    await acao('Trocar automação')
    await janelaEscolha.getByRole('combobox', { name: 'Buscar automação' }).fill(`Atendimento ${tag}`)
    await janelaEscolha.getByRole('option', { name: new RegExp(`Atendimento ${tag}`) }).click()
    await janelaEscolha.getByRole('button', { name: 'Escolher', exact: true }).click()
    expect((await volta).status()).toBe(200)
    await expect(resposta.getByRole('link', { name: `Atendimento ${tag}` })).toBeVisible()
    await acao('Editar configuração')
    await expect(page.getByRole('dialog').getByText('Recebi sua mensagem e vou ajudar.', { exact: true })).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Salvar configuração', exact: true })).toBeInViewport()
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Remover automação escolhida' })).toBeVisible()
    await page.screenshot({ path: caminhoPrint(`clone-screens/repintura/06-basico-config-${info.project.name}.png`), scale: 'css', animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await escolher(page, 'Frequência da resposta', 'Toda vez', page.getByRole('dialog'))
    const changed = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/api/basic/'))
    await page.getByRole('dialog').getByRole('button', { name: 'Salvar configuração', exact: true }).click()
    expect((await changed).status()).toBe(200)
    await deliver('Uma nova mensagem com frequência livre')
    await expect.poll(() => fake!.enviadas().length, { timeout: 30_000 }).toBe(3)
    // Criar nova mantém a entrada desligada até a publicação e ativação explícitas.
    await acao('Editar configuração')
    const created = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/automations')
    await page.getByRole('dialog').getByRole('button', { name: 'Criar nova automação', exact: true }).click()
    const draft = await (await created).json() as { id: string }
    automations.push(draft.id)
    await expect(page).toHaveURL(new RegExp(`/automations/${draft.id}$`))
    const basic = await api<{ entries: { connection_id: string; kind: string; automation_id: string; enabled: boolean }[] }>('/api/basic')
    expect(basic.entries.find(entry => entry.connection_id === connection && entry.kind === 'default_reply'))
      .toMatchObject({ automation_id: draft.id, enabled: false })

  } finally {
    await fake?.fechar()
    if (connection) sql([
      `DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT contact_id FROM contact_channels WHERE channel_id='${q(connection)}')`,
      `DELETE FROM inbound_events WHERE channel_id='${q(connection)}'`,
      `DELETE FROM channels WHERE workspace_id='${WORKSPACE}' AND id='${q(connection)}'`,
    ])
    if (automations.length) sql(automations.map(id => `DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(id)}'`))
  }
})
