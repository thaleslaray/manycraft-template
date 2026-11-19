import { test, expect } from './fixtures'
import { ENGINE, WORKSPACE, api, consulta, maisDaLateral, novoTag, q, sql, caminhoPrint } from './helpers'
import { subirTelegramFalso, type TelegramFalso } from './telegram-falso'

test('métricas por gatilho conferem com execuções no D1 e abrem os contatos corretos', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(150_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development).toBeTruthy()
  const tag = novoTag(), bot = 7_000_000 + Math.floor(Math.random() * 999_999)
  let fake: TelegramFalso | undefined, connection: string | undefined, id: string | undefined
  try {
    fake = await subirTelegramFalso(Number(new URL(catalog.development!.providerApiBase).port), { [`${bot}:e2e-${tag}`]: { id: bot, username: `e2e_${tag}` } })
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', displayName: 'Estudos de métricas', credentials: { botToken: `${bot}:e2e-${tag}` } }) })).connection.id
    id = (await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: `Métricas de material ${tag}` }) })).id
    await api(`/api/automations/${id}/draft`, { method: 'PUT', body: JSON.stringify({ graph: {
      nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'm', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Seu material de estudo chegou.' }, { kind: 'button', id: 'b', label: 'Continuar', action: { type: 'go_to_node' } }] } }, { id: 'm2', type: 'message', position: { x: 720, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Boa leitura!' }] } }],
      edges: [{ from: 't', port: 'next', to: 'm' }, { from: 'm', port: 'btn:b', to: 'm2' }],
    } }) })
    const triggers: string[] = []
    for (const [name, word] of [['Material', `material${tag}`], ['Agenda', `agenda${tag}`]]) {
      const t = await api<{ id: string }>(`/api/automations/${id}/triggers`, { method: 'POST', body: JSON.stringify({ name, connection_id: connection, node_id: 't', rule: 'contains', words: [word] }) })
      triggers.push(t.id)
    }
    // O motor só ativa gatilho de automação já publicada (409 antes disso).
    await api(`/api/automations/${id}/publish`, { method: 'POST' })
    for (const t of triggers) await api(`/api/automations/${id}/triggers/${t}`, { method: 'PATCH', body: JSON.stringify({ state: 'active' }) })
    let serial = Date.now()
    async function deliver(person: number, name: string, text: string, click?: string) {
      const hook = fake!.webhook()!, update = ++serial
      const payload = click ? { callback_query: { id: String(update), from: { id: person, first_name: name }, data: click, message: { message_id: update, chat: { id: person, type: 'private' } } } }
        : { message: { message_id: update, from: { id: person, first_name: name }, chat: { id: person, type: 'private' }, text } }
      expect((await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token }, body: JSON.stringify({ update_id: update, ...payload }) })).status).toBe(200)
    }
    await deliver(bot + 1, 'Ana Material', `material${tag}`)
    await expect.poll(() => fake!.enviadas().length, { timeout: 30_000 }).toBe(1)
    const markup = fake.chamadas.find(c => c.metodo === 'sendMessage')!.corpo.reply_markup as { inline_keyboard: { callback_data: string }[][] }
    await deliver(bot + 1, 'Ana Material', '', markup.inline_keyboard[0][0].callback_data)
    await expect.poll(() => fake!.enviadas().length, { timeout: 30_000 }).toBe(2)
    await expect.poll(() => fake!.chamadas.filter(c => c.metodo === 'answerCallbackQuery').length).toBeGreaterThan(0)
    await deliver(bot + 1, 'Ana Material', `material${tag}`)
    await expect.poll(() => fake!.enviadas().length, { timeout: 30_000 }).toBe(3)
    await deliver(bot + 2, 'Bruno Agenda', `agenda${tag}`)
    await expect.poll(() => fake!.enviadas().length, { timeout: 30_000 }).toBe(4)
    // An existing opt-in with no imported first-inbound marker is not a new subscription.
    sql([`INSERT INTO contacts(id,workspace_id,first_name) VALUES ('e2e-old-${tag}','${WORKSPACE}','Carla existente')`,
      `INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('e2e-old-cc-${tag}','${WORKSPACE}','e2e-old-${tag}','${q(connection)}','${bot + 3}',1)`])
    await deliver(bot + 3, 'Carla existente', `material${tag}`)
    await expect.poll(() => fake!.enviadas().length, { timeout: 30_000 }).toBe(5)
    expect(consulta<{ n: number }>(`SELECT sum(trigger_opt_in) n FROM flow_runs WHERE trigger_id='${q(triggers[0])}'`)[0].n).toBe(1)
    expect(consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs WHERE trigger_id='${q(triggers[0])}'`)[0].n).toBe(3)
    if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    const panel = page.getByRole('region', { name: 'Métricas por gatilho' })
    await expect(panel.getByRole('button', { name: 'Envios: 4 vezes', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Contatos únicos: 3', exact: true })).toBeVisible()
    await maisDaLateral(page, 'Mais métricas')
    await expect(panel.getByRole('button', { name: 'Execuções: 4', exact: true })).toBeVisible()
    await panel.getByRole('combobox', { name: 'Filtrar métricas por gatilho' }).click()
    await page.getByRole('option', { name: 'Material', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Execuções: 3', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Opt-ins: 1', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Enviadas: 2', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Clicadas: 1', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'CTR: 50%', exact: true })).toBeVisible()
    await expect(panel.getByText('Sem suporte', { exact: true })).toHaveCount(2)
    const screenshot = (screen: string) => process.env.E2E_CAPTURE_SCREENS === '1'
      ? caminhoPrint(`clone-screens/39-${screen}-${info.project.name}.png`) : info.outputPath(`${screen}.png`)
    if (info.project.name === 'mobile') await panel.evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 72))
    await page.screenshot({ path: screenshot('metricas'), scale: 'css', animations: 'disabled' })
    await panel.getByRole('button', { name: 'Clicadas: 1', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('link', { name: 'Ana Material', exact: true })).toBeVisible()
    await expect(dialog.getByText('Bruno Agenda')).toHaveCount(0)
    await page.screenshot({ path: screenshot('contatos'), scale: 'css', animations: 'disabled' })
    await dialog.getByRole('link', { name: 'Ana Material', exact: true }).click()
    await expect(page).toHaveURL(/\/contacts\?contact=/)
    await expect(page.getByRole('dialog')).toContainText('Ana Material')
    await page.goBack()
    await maisDaLateral(page, 'Mais métricas')
    await panel.getByRole('combobox', { name: 'Filtrar métricas por gatilho' }).click()
    await page.getByRole('option', { name: 'Agenda', exact: true }).click()
    await panel.getByRole('button', { name: 'Clicadas: 0', exact: true }).click()
    await expect(dialog.getByText('Nenhum contato nesta métrica.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Fechar', exact: true }).click()
    await page.reload()
    await maisDaLateral(page, 'Mais métricas')
    await expect(panel.getByRole('button', { name: 'Execuções: 4', exact: true })).toBeVisible()
    await page.goto(`/${WORKSPACE}/automations`)
    await page.getByRole('textbox', { name: 'Buscar automação' }).fill(`Métricas de material ${tag}`)
    await expect(page.getByRole('link', { name: `Métricas de material ${tag}`, exact: true })).toBeVisible()
    if (info.project.name === 'desktop') {
      // As métricas por coluna ficam na visualização em lista; o padrão é o de cartões.
      await page.getByRole('button', { name: 'Visualização no formato de lista', exact: true }).click()
      await expect(page.getByRole('columnheader', { name: 'Entregues', exact: true })).toBeVisible()
      await expect(page.getByRole('columnheader', { name: 'Lidas', exact: true })).toBeVisible()
    }
    await page.screenshot({ path: screenshot('lista'), scale: 'css', animations: 'disabled' })
  } finally {
    await fake?.fechar()
    const ws = `workspace_id='${WORKSPACE}'`
    if (connection) sql([`DELETE FROM contacts WHERE ${ws} AND id IN (SELECT contact_id FROM contact_channels WHERE ${ws} AND channel_id='${q(connection)}')`, `DELETE FROM inbound_events WHERE ${ws} AND channel_id='${q(connection)}'`, `DELETE FROM channels WHERE ${ws} AND id='${q(connection)}'`])
    if (id) sql([`DELETE FROM automations WHERE ${ws} AND id='${q(id)}'`])
  }
})
