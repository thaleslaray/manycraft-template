import { test, expect } from './fixtures'
import { ENGINE, WORKSPACE, api, consulta, novoTag, q, sql, caminhoPrint, novoGatilho, abrirMaisOpcoes } from './helpers'
import { subirTelegramFalso, type TelegramFalso } from './telegram-falso'

test('vários gatilhos persistem política e estado; duas entradas geram uma resposta por contato', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(150_000)
  page.setDefaultTimeout(10_000)
  async function saveTrigger() {
    const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && /\/triggers\/[^/]+$/.test(new URL(response.url()).pathname))
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    expect((await saved).status()).toBe(200)
    await expect(page.getByText('Palavra-chave salva', { exact: true }).last()).toBeVisible()
  }
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'Exige transporte falso local').toBeTruthy()
  const tag = novoTag(), bot = 8_000_000 + Math.floor(Math.random() * 999_999)
  const word = `material${tag}`, otherWord = `agenda${tag}`, reply = 'Seu material está pronto para consulta.'
  let fake: TelegramFalso | undefined, connection: string | undefined, id: string | undefined
  try {
    fake = await subirTelegramFalso(Number(new URL(catalog.development!.providerApiBase).port), { [`${bot}:e2e-${tag}`]: { id: bot, username: `e2e_${tag}` } })
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', displayName: 'Bot de estudos local', credentials: { botToken: `${bot}:e2e-${tag}` } }) })).connection.id
    id = (await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: 'Entrega de material' }) })).id
    await api(`/api/automations/${id}/draft`, { method: 'PUT', body: JSON.stringify({ graph: {
      nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'message', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [{ kind: 'text', text: reply }] } }],
      edges: [{ from: 'trigger', port: 'next', to: 'message' }],
    } }) })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await page.locator('.react-flow__node-trigger').click({ position: { x: 40, y: 16 } })
    await novoGatilho(page, 'Telegram', /Mensagem no Telegram/)
    await page.getByLabel('Nome do gatilho').fill('Pedido de material')
    await page.getByRole('combobox', { name: 'Conexão' }).click()
    await page.getByRole('option', { name: 'Bot de estudos local', exact: true }).click()
    await page.getByRole('textbox', { name: 'Nova palavra: Palavras da mensagem', exact: true }).fill(word)
    await page.getByRole('textbox', { name: 'Nova palavra: Palavras da mensagem', exact: true }).press('Enter')
    await page.getByRole('button', { name: 'Criar gatilho', exact: true }).click()
    await expect(page.getByText('Gatilho criado', { exact: true })).toBeVisible()
    await abrirMaisOpcoes(page)
    await page.getByRole('combobox', { name: 'Política de disparo' }).click()
    await page.getByRole('option', { name: 'Uma vez por contato', exact: true }).click()
    // Ativar exige automação publicada (o motor responde 409 antes disso): o primeiro gatilho só ganha política agora.
    await saveTrigger()
    await novoGatilho(page, 'Telegram', /Mensagem no Telegram/)
    await page.getByLabel('Nome do gatilho').fill('Pedido de agenda')
    await page.getByRole('combobox', { name: 'Conexão' }).click()
    await page.getByRole('option', { name: 'Bot de estudos local', exact: true }).click()
    await page.getByRole('textbox', { name: 'Nova palavra: Palavras da mensagem', exact: true }).fill(otherWord)
    await page.getByRole('textbox', { name: 'Nova palavra: Palavras da mensagem', exact: true }).press('Enter')
    await page.getByRole('button', { name: 'Criar gatilho', exact: true }).click()
    // O gatilho nasce no estado Inicial (interruptor desligado, não dispara); publicar o liga.
    await expect(page.getByRole('switch', { name: 'Gatilho ativo' })).not.toBeChecked()
    await abrirMaisOpcoes(page)
    await expect(page.getByText('(este está no estado Inicial)')).toBeVisible()
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Ao vivo', { exact: true })).toBeVisible()
    await page.reload()
    await page.locator('.react-flow__node-trigger').click({ position: { x: 40, y: 16 } })
    await page.getByRole('button', { name: 'Editar', exact: true }).first().click()
    await page.getByRole('button', { name: 'Configurar Pedido de material', exact: true }).click()
    await abrirMaisOpcoes(page)
    await expect(page.getByRole('combobox', { name: 'Política de disparo' })).toContainText('Uma vez por contato')
    // Publicar ligou os dois gatilhos que estavam no estado Inicial.
    await expect(page.getByRole('switch', { name: 'Gatilho ativo' })).toBeChecked()
    // Desligar e salvar depois de publicar deixa o gatilho em Rascunho (publicar de novo não o religa).
    await page.getByRole('button', { name: 'Configurar Pedido de agenda', exact: true }).click()
    const ativo = page.getByRole('switch', { name: 'Gatilho ativo' })
    await expect(ativo).toBeChecked()
    await ativo.click()
    await saveTrigger()
    await expect(ativo).not.toBeChecked()
    await abrirMaisOpcoes(page)
    await expect(page.getByText('(este está no estado Inicial)')).toHaveCount(0)
    let serial = Date.now(), delivered = 0
    async function deliver(text: string) {
      const hook = fake!.webhook()!, update = ++serial
      const response = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token },
        body: JSON.stringify({ update_id: update, message: { message_id: update, from: { id: bot + 1, first_name: 'Pessoa de teste' }, chat: { id: bot + 1, type: 'private' }, text } }) })
      expect(response.status).toBe(200)
      delivered++
      await expect(async () => expect(consulta<{ n: number }>(`SELECT count(*) n FROM inbound_events WHERE channel_id='${q(connection!)}' AND planned_at IS NOT NULL`)[0]?.n).toBe(delivered)).toPass({ timeout: 30_000 })
    }
    await deliver(word)
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([reply])
    await deliver(word)
    expect(consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs WHERE channel_id='${q(connection)}'`)[0]?.n).toBe(1)
    expect(fake.enviadas().map(m => m.text)).toEqual([reply])
    await deliver(otherWord)
    expect(consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs WHERE channel_id='${q(connection)}'`)[0]?.n).toBe(1)
    expect(fake.enviadas().map(m => m.text)).toEqual([reply])
    // Rascunho não dispara mesmo com automação ao vivo; ativar o segundo mantém o primeiro intacto.
    await page.getByRole('button', { name: 'Configurar Pedido de agenda', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Gatilho ativo' })).not.toBeChecked()
    await page.getByRole('switch', { name: 'Gatilho ativo' }).click()
    await saveTrigger()
    await deliver(otherWord)
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([reply, reply])
    await page.getByRole('button', { name: 'Configurar Pedido de material', exact: true }).click()
    const path = process.env.E2E_CAPTURE_SCREENS === '1'
      ? caminhoPrint(`clone-screens/11-gatilhos-${info.project.name}.png`) : info.outputPath('gatilhos.png')
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.getByRole('list', { name: 'Passos da automação' })).toContainText('Uma vez por contato')
      await expect(page.getByRole('list', { name: 'Passos da automação' })).toContainText(/Pedido de agenda:[^·]+· Ativo/)
    }
    if (info.project.name === 'desktop') await page.getByRole('switch', { name: 'Gatilho ativo' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path, scale: 'css' })
  } finally {
    await fake?.fechar()
    const ws = `workspace_id='${WORKSPACE}'`
    if (connection) sql([
      `DELETE FROM contacts WHERE ${ws} AND id IN (SELECT contact_id FROM contact_channels WHERE ${ws} AND channel_id='${q(connection)}')`,
      `DELETE FROM inbound_events WHERE ${ws} AND channel_id='${q(connection)}'`,
      `DELETE FROM channels WHERE ${ws} AND id='${q(connection)}'`,
    ])
    if (id) sql([`DELETE FROM automations WHERE ${ws} AND id='${q(id)}'`])
  }
})
