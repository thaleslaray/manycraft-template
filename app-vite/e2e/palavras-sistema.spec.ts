import { test, expect } from './fixtures'
import { ENGINE, WORKSPACE, api, consulta, novoTag, q, sql, caminhoPrint, escolher, escolherAutomacao } from './helpers'
import { subirTelegramFalso, type TelegramFalso } from './telegram-falso'

test('palavras de sistema alteram a inscrição por conexão, confirmam e bloqueiam envios durante o descadastro', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(180_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'A jornada exige transporte falso local').toBeTruthy()
  const provider = new URL(catalog.development!.providerApiBase)
  expect(['127.0.0.1', 'localhost']).toContain(provider.hostname)
  const tag = novoTag(), bot = 9_000_000 + Math.floor(Math.random() * 900_000)
  const token = `${bot}:e2e-${tag}`, name = `Inscrição local ${tag}`
  const automations: string[] = []
  let fake: TelegramFalso | undefined, connection: string | undefined
  const texts = ['Seu recebimento foi cancelado nesta conexão.', 'Seu recebimento foi autorizado novamente.', 'Recebi sua mensagem e vou ajudar.']
  const titles = [`Descadastro ${tag}`, `Inscrição ${tag}`, `Atendimento ${tag}`]
  const screenshot = async (screen: string) => page.screenshot({
    path: process.env.E2E_CAPTURE_SCREENS === '1'
      ? caminhoPrint(`clone-screens/14-${screen}-${info.project.name}.png`)
      : info.outputPath(`${screen}.png`), scale: 'css', animations: 'disabled',
  })
  try {
    fake = await subirTelegramFalso(Number(provider.port), { [token]: { id: bot, username: `sistema_${tag}` } })
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', displayName: name, credentials: { botToken: token } }) })).connection.id
    const keywordCount = () => consulta<{ n: number }>(`SELECT count(*) n FROM keywords k JOIN triggers t ON t.id=k.trigger_id AND t.workspace_id=k.workspace_id WHERE t.workspace_id='${WORKSPACE}' AND t.channel_id='${q(connection!)}'`)[0].n
    const beforeKeywords = keywordCount()
    for (const [index, title] of titles.entries()) {
      const id = (await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: title }) })).id
      automations.push(id)
      await api(`/api/automations/${id}/draft`, { method: 'PUT', body: JSON.stringify({ graph: {
        nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'message', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [{ kind: 'text', text: texts[index] }] } }],
        edges: [{ from: 'trigger', port: 'next', to: 'message' }],
      } }) })
      await api(`/api/automations/${id}/publish`, { method: 'POST' })
    }
    await api(`/api/basic/${connection}/default_reply`, { method: 'PUT', body: JSON.stringify({ automation_id: automations[2], enabled: true, repeat_mode: 'every_time', dm_only: false }) })
    await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/basic`)
    const conta = page.getByRole('region', { name, exact: true })
    for (const [index, action] of ['Configurar descadastro', 'Configurar inscrição'].entries()) {
      await conta.getByRole('button', { name: action, exact: true }).click()
      const dialog = page.getByRole('dialog')
      await escolherAutomacao(page, dialog, titles[index])
      await expect(dialog.getByText(texts[index], { exact: true })).toBeVisible()
      await expect(dialog.getByRole('combobox', { name: 'Frequência da resposta', exact: true })).toHaveCount(0)
      const enabled = dialog.getByRole('switch', { name: /Ativar / })
      if (await enabled.getAttribute('aria-checked') !== 'true') await enabled.click()
      const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(`/api/basic/${connection}/system_opt_${index === 0 ? 'out' : 'in'}`))
      await dialog.getByRole('button', { name: 'Salvar configuração', exact: true }).click()
      expect((await saved).status()).toBe(200)
      await expect(dialog).not.toBeVisible()
    }
    await page.reload()
    for (const [index, region] of ['Confirmação de descadastro', 'Confirmação de inscrição'].entries()) {
      await expect(conta.getByRole('region', { name: region, exact: true }).getByRole('link', { name: titles[index], exact: true })).toBeVisible()
      await expect(conta.getByRole('region', { name: region, exact: true }).getByText('Ativo', { exact: true })).toBeVisible()
    }
    const settings = await api<{ entries: { connection_id: string; kind: string; automation_id: string; enabled: boolean; repeat_mode: string; dm_only: boolean }[] }>('/api/basic')
    for (const [index, kind] of ['system_opt_out', 'system_opt_in'].entries()) expect(settings.entries.find(entry => entry.connection_id === connection && entry.kind === kind))
      .toMatchObject({ automation_id: automations[index], enabled: true, repeat_mode: 'every_time', dm_only: false })
    expect(keywordCount(), 'Confirmações não consomem palavras-chave').toBe(beforeKeywords)
    await conta.getByRole('region', { name: 'Confirmação de descadastro', exact: true }).scrollIntoViewIfNeeded()
    await screenshot('sistema')
    await conta.getByRole('region', { name: 'Confirmação de descadastro', exact: true }).getByRole('button', { name: 'Mais ações de confirmação de descadastro' }).click()
    await page.getByRole('menuitem', { name: 'Editar configuração', exact: true }).click()
    await expect(page.getByRole('dialog').getByText(texts[0], { exact: true })).toBeVisible()
    await screenshot('confirmacao')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole('dialog').getByRole('button', { name: 'Cancelar', exact: true }).click()

    let update = Date.now(), planned = 0
    async function deliver(text: string) {
      const hook = fake!.webhook()!, id = ++update
      const response = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token },
        body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: bot + 1, first_name: 'Pessoa local' }, chat: { id: bot + 1, type: 'private' }, text } }),
      })
      expect(response.status).toBe(200)
      await expect(async () => expect(consulta<{ n: number }>(`SELECT count(*) n FROM inbound_events WHERE channel_id='${q(connection!)}' AND planned_at IS NOT NULL`)[0].n).toBe(planned + 1)).toPass({ timeout: 30_000 })
      planned++
    }
    const sent = () => fake!.enviadas().map(message => message.text)
    const runCount = () => consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs WHERE channel_id='${q(connection!)}'`)[0].n
    const timeline = () => consulta<{ text: string }>(`SELECT json_extract(m.content,'$.text') text FROM messages m JOIN conversations v ON v.workspace_id=m.workspace_id AND v.id=m.conversation_id JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id WHERE cc.workspace_id='${WORKSPACE}' AND cc.channel_id='${q(connection!)}' AND json_extract(m.content,'$.sender')='system' ORDER BY m.created_at,m.rowid`).map(message => message.text)
    const audience = () => api<{ count: number; eligible: number }>(`/api/broadcasts/audience?tag=all&channel=telegram&channel_id=${encodeURIComponent(connection!)}`)
    await deliver('parar')
    await expect.poll(sent, { timeout: 30_000 }).toEqual([texts[0]])
    expect(runCount(), 'Parar dispara somente a confirmação de descadastro').toBe(1)
    const identity = consulta<{ contact_id: string; opted_in: number }>(`SELECT contact_id,opted_in FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND channel_id='${q(connection)}' AND external_user_id='${bot + 1}'`)[0]
    expect(identity.opted_in).toBe(0)
    expect(timeline()).toContain('Inscrição cancelada nesta conexão.')
    await page.goto(`/${WORKSPACE}/contacts?contact=${encodeURIComponent(identity.contact_id)}`)
    const subscriptions = page.getByRole('dialog').getByRole('region', { name: 'Inscrição por conexão' })
    await expect(subscriptions).toContainText(name)
    await expect(subscriptions).toContainText('Inscrição cancelada')
    await page.reload()
    await expect(subscriptions).toContainText('Inscrição cancelada')
    await subscriptions.scrollIntoViewIfNeeded()
    await screenshot('perfil')
    await deliver('Uma dúvida durante o descadastro')
    expect(runCount(), 'Mensagem comum não inicia automação enquanto descadastrado').toBe(1)
    expect(sent()).toEqual([texts[0]])
    expect(await audience(), 'Contato descadastrado não é elegível para transmissão').toEqual({ count: 1, eligible: 0 })
    await deliver('voltar')
    await expect.poll(sent, { timeout: 30_000 }).toEqual([texts[0], texts[1]])
    expect(runCount(), 'Voltar dispara somente a confirmação de inscrição').toBe(2)
    expect(timeline()).toEqual(expect.arrayContaining(['Inscrição cancelada nesta conexão.', 'Inscrição retomada nesta conexão.']))
    expect(consulta<{ opted_in: number }>(`SELECT opted_in FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND channel_id='${q(connection)}' AND contact_id='${q(identity.contact_id)}'`)[0].opted_in).toBe(1)
    await page.reload()
    await expect(subscriptions).toContainText('Recebimento autorizado')
    expect(await audience()).toEqual({ count: 1, eligible: 1 })
    await deliver('Uma nova dúvida após a inscrição')
    await expect.poll(sent, { timeout: 30_000 }).toEqual([texts[0], texts[1], texts[2]])
    expect(runCount()).toBe(3)
    expect(keywordCount()).toBe(beforeKeywords)
  } finally {
    await fake?.fechar()
    if (connection) sql([
      `DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT contact_id FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND channel_id='${q(connection)}')`,
      `DELETE FROM inbound_events WHERE channel_id='${q(connection)}'`,
      `DELETE FROM channels WHERE workspace_id='${WORKSPACE}' AND id='${q(connection)}'`,
    ])
    if (automations.length) sql(automations.map(id => `DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(id)}'`))
  }
})
