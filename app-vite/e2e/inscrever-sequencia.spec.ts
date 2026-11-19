import { test, expect } from './fixtures'
import { ENGINE, api, q, WORKSPACE, canalE2eSql, consulta, contatoSql, limpezaSql, novoTag, sql, escolherCanalDoPasso, caminhoPrint, abrirAcao } from './helpers'
import { subirTelegramFalso, type TelegramFalso } from './telegram-falso'

test('inscrição em lote aparece no perfil, persiste e reinicia depois de cancelar', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(120_000)
  const t = novoTag(), canal = `e2e-canal-${t}`, seq = `e2e-seq-${t}`, name = `Boas-vindas ${t}`
  const ids = [`e2e-seq-a-${t}`, `e2e-seq-b-${t}`]
  sql([...canalE2eSql(canal), ...ids.flatMap((id, i) => contatoSql({ id, canal, nome: `Pessoa ${i + 1}`, sobrenome: `Serie${t}` })),
    `INSERT INTO sequences(id,workspace_id,name) VALUES ('${seq}','${WORKSPACE}','${name}')`,
    `INSERT INTO sequence_steps(id,workspace_id,sequence_id,position,delay_seconds,status) VALUES ('e2e-step-${t}','${WORKSPACE}','${seq}',0,3600,'live')`])
  const capture = async (screen: string) => {
    if (process.env.E2E_CAPTURE_SCREENS === '1') {
      await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 })
      await page.screenshot({ path: caminhoPrint(`clone-screens/09-${screen}-${info.project.name}.png`), scale: 'css' })
    }
  }
  try {
    async function enroll() {
      await page.goto(`/${WORKSPACE}/contacts`)
      await page.getByRole('textbox', { name: 'Buscar contato' }).fill(`Serie${t}`)
      await expect(page.getByRole('button', { name: `Pessoa 2 Serie${t}`, exact: true })).toBeVisible()
      await expect(page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: /^Selecionar / }) })).toHaveCount(3)
      await page.getByRole('checkbox', { name: 'Selecionar todos', exact: true }).check()
      await page.getByRole('button', { name: 'Ações em lote', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Inscrever em sequência…', exact: true }).click({ timeout: 3000 })
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('combobox', { name: 'Sequência', exact: true }).click()
      await page.getByRole('option', { name, exact: true }).click()
      await expect(page.getByRole('listbox')).toHaveCount(0)
      await capture('lote')
      await dialog.getByRole('button', { name: 'Inscrever', exact: true }).click()
      await expect(dialog).toHaveCount(0)
    }
    await enroll()
    const subscriptions = () => consulta<{ contact_id: string; enrollment_id: string; next_step: number; next_at: number }>(`SELECT contact_id,enrollment_id,next_step,next_at FROM sequence_subscriptions WHERE sequence_id='${seq}' ORDER BY contact_id`)
    expect(subscriptions().map(s => s.contact_id)).toEqual(ids)
    const original = subscriptions()[0]
    await enroll()
    expect(subscriptions()[0]).toEqual(original) // Uma inscrição existente não é reiniciada por acidente.
    await page.goto(`/${WORKSPACE}/contacts?contact=${ids[0]}`)
    const section = page.getByRole('region', { name: 'Sequências do contato' })
    await expect(section).toContainText(name)
    await page.reload()
    await expect(section).toContainText(name)
    await section.scrollIntoViewIfNeeded()
    await capture('perfil')
    await section.getByRole('button', { name: `Cancelar sequência ${name}`, exact: true }).click()
    await expect(section).toContainText('Nenhuma sequência inscrita.')
    await page.reload()
    await expect(section).toContainText('Nenhuma sequência inscrita.')
    expect(subscriptions().map(s => s.contact_id)).toEqual([ids[1]])
    await enroll()
    const restarted = subscriptions()[0]
    expect(restarted.enrollment_id).not.toBe(original.enrollment_id)
    expect(restarted.next_step).toBe(0)
    expect(restarted.next_at).toBeGreaterThan(original.next_at)
  } finally { sql([`DELETE FROM sequences WHERE id='${seq}'`, ...limpezaSql()]) }
})

test('automação inscreve e cancela; perfil mostra e o primeiro passo chega no Telegram falso', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(150_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'Exige transporte falso local').toBeTruthy()
  const t = novoTag(), bot = 9_000_000 + Math.floor(Math.random() * 999_999), name = `Série de estudo ${t}`, word = `serie${t}`
  const reply = `Aqui está o primeiro conteúdo da série ${t}`, confirmation = `Pedido da série recebido ${t}`
  let fake: TelegramFalso | undefined, connection: string | undefined, sequence: string | undefined, automation: string | undefined, destination: string | undefined
  try {
    fake = await subirTelegramFalso(Number(new URL(catalog.development!.providerApiBase).port), { [`${bot}:e2e-${t}`]: { id: bot, username: `e2e_${t}` } })
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', displayName: `e2e Série ${t}`, credentials: { botToken: `${bot}:e2e-${t}` } }) })).connection.id
    destination = (await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: `Conteúdo ${t}` }) })).id
    await api(`/api/automations/${destination}/draft`, { method: 'PUT', body: JSON.stringify({ graph: { nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      { id: 'message', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [{ id: 'text', kind: 'text', text: reply }] } },
    ], edges: [{ from: 'trigger', port: 'next', to: 'message' }] } }) })
    await api(`/api/automations/${destination}/publish`, { method: 'POST' })
    sequence = (await api<{ id: string }>('/api/sequences', { method: 'POST', body: JSON.stringify({ name, steps: [{ id: `e2e-first-${t}`, delay_seconds: 0, sending_time_settings: { type: 'all' }, status: 'live', automation_id: destination }] }) })).id
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations`)
    await page.getByRole('button', { name: 'Nova automação', exact: true }).first().click()
    await page.getByRole('button', { name: 'Começar do zero', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Nome da automação' })).toHaveValue('Nova automação')
    automation = page.url().split('/').pop()!
    await page.getByRole('button', { name: 'Adicionar passo', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Ações', exact: true }).click()
    await page.getByRole('button', { name: 'Adicionar ação', exact: true }).click()
    await page.getByRole('combobox', { name: 'Ação 1', exact: true }).click()
    await page.getByRole('option', { name: 'Inscrever na sequência', exact: true }).click({ timeout: 3000 })
    await page.getByRole('combobox', { name: 'Sequência', exact: true }).click()
    await page.getByRole('option', { name, exact: true }).click()
    // O publicador atual exige uma mensagem na automação de entrada.
    await page.getByRole('button', { name: 'Adicionar passo', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Mensagem', exact: true }).click()
    await escolherCanalDoPasso(page, 'Telegram')
    await page.getByRole('textbox', { name: 'Texto do bloco 1' }).fill(confirmation)
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByText('Rascunho salvo', { exact: true })).toBeVisible()
    await page.reload()
    await page.locator('.react-flow__node-action').click()
    await abrirAcao(page, 1)
    await expect(page.getByRole('combobox', { name: 'Ação 1', exact: true })).toContainText('Inscrever na sequência')
    await expect(page.getByRole('combobox', { name: 'Sequência', exact: true })).toContainText(name)
    if (process.env.E2E_CAPTURE_SCREENS === '1' && info.project.name === 'desktop') await page.screenshot({ path: caminhoPrint('clone-screens/09-editor-desktop.png'), scale: 'css' })
    // Publicar sem gatilho é barrado: este gatilho nasce desligado só para a publicação passar.
    const prepared = await api<{ automation: { draft_graph: { nodes: { id: string; type: string }[] } } }>(`/api/automations/${automation}`)
    const trigger = await api<{ id: string }>(`/api/automations/${automation}/triggers`, { method: 'POST', body: JSON.stringify({ name: `Entrar na série ${t}`, connection_id: connection, node_id: prepared.automation.draft_graph.nodes.find(node => node.type === 'trigger')!.id, words: [word], rule: 'is' }) })
    await page.reload()
    // O catálogo de sequências chega depois do mapa: publicar antes disso valida a ação sem a sequência e só abre o painel com o erro.
    await page.locator('.react-flow__node-action').click()
    await abrirAcao(page, 1)
    await expect(page.getByRole('combobox', { name: 'Sequência', exact: true })).toContainText(name)
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Ao vivo', { exact: true })).toBeVisible()
    await api(`/api/automations/${automation}/triggers/${trigger.id}`, { method: 'PATCH', body: JSON.stringify({ state: 'active' }) })
    let update = Date.now()
    async function deliver() {
      const hook = fake!.webhook()!, event = ++update
      const response = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token }, body: JSON.stringify({ update_id: event, message: { message_id: event, from: { id: bot + 1, first_name: `Pessoa${t}` }, chat: { id: bot + 1, type: 'private' }, text: word } }) })
      expect(response.status).toBe(200)
    }
    await deliver()
    // A CLI do D1 é síncrona: aguarde o HTTP falso antes de bloquear o processo que o serve.
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([confirmation])
    await expect(async () => { expect(consulta(`SELECT contact_id FROM sequence_subscriptions WHERE sequence_id='${q(sequence!)}'`)).toHaveLength(1) }).toPass({ timeout: 30_000 })
    const contact = consulta<{ contact_id: string }>(`SELECT contact_id FROM sequence_subscriptions WHERE sequence_id='${q(sequence)}'`)[0].contact_id
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.getByRole('list', { name: 'Passos da automação' })).toContainText(`Inscreve na sequência ${name}`)
      if (process.env.E2E_CAPTURE_SCREENS === '1') await page.screenshot({ path: caminhoPrint('clone-screens/09-editor-mobile.png'), scale: 'css' })
    }
    await page.goto(`/${WORKSPACE}/contacts?contact=${contact}`)
    await expect(page.getByRole('region', { name: 'Sequências do contato' })).toContainText(name)
    await page.reload()
    await expect(page.getByRole('region', { name: 'Sequências do contato' })).toContainText(name)
    const tick = await fetch(`${ENGINE}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('* * * * *')}`)
    expect(tick.status).toBe(200)
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([confirmation, reply])
    expect(fake.enviadas()[1].chat_id).toBe(String(bot + 1))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${automation}`)
    await page.getByRole('button', { name: 'Editar', exact: true }).first().click()
    await page.locator('.react-flow__node-action').click()
    await abrirAcao(page, 1)
    await page.getByRole('combobox', { name: 'Ação 1', exact: true }).click()
    await page.getByRole('option', { name: 'Cancelar sequência', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Sequência', exact: true })).toContainText(name)
    // "Ao vivo" já aparecia antes (versão 1): a mensagem só pode chegar depois que a versão nova foi gravada. Com o webhook respondendo
    // na hora, uma mensagem enviada no meio da publicação roda (corretamente) a versão anterior, que inscreve de novo.
    const republished = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/automations/${automation}/publish`))
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    expect((await republished).ok()).toBe(true)
    await expect(page.getByText('Ao vivo', { exact: true })).toBeVisible()
    await deliver()
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([confirmation, reply, confirmation])
    await expect(async () => { expect(consulta(`SELECT contact_id FROM sequence_subscriptions WHERE sequence_id='${q(sequence!)}'`)).toHaveLength(0) }).toPass({ timeout: 30_000 })
    await page.goto(`/${WORKSPACE}/contacts?contact=${contact}`)
    await expect(page.getByRole('region', { name: 'Sequências do contato' })).toContainText('Nenhuma sequência inscrita.')
  } finally {
    await fake?.fechar()
    if (sequence) sql([`DELETE FROM sequences WHERE id='${q(sequence)}'`])
    const ws = `workspace_id='${WORKSPACE}'`
    if (connection) sql([`DELETE FROM contacts WHERE ${ws} AND id IN (SELECT contact_id FROM contact_channels WHERE ${ws} AND channel_id='${q(connection)}')`, `DELETE FROM inbound_events WHERE ${ws} AND channel_id='${q(connection)}'`, `DELETE FROM channels WHERE ${ws} AND id='${q(connection)}'`])
    for (const id of [automation, destination]) if (id) sql([`DELETE FROM automations WHERE ${ws} AND id='${q(id)}'`])
  }
})
