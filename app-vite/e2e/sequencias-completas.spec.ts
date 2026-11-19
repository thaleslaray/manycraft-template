import { test, expect } from './fixtures'
import { api, ENGINE, WORKSPACE, novoTag, q, sql, canalE2eSql, contatoSql, consulta, caminhoPrint, escolher } from './helpers'

test('sequência permite renomear e duplicar pela lista, preservando passos sem copiar estatísticas', { tag: "@celular" }, async ({ page }, info) => {
  const tag = novoTag(), original = `Acompanhamento ${tag}`, renamed = `Relacionamento ${tag}`
  const created = await api<{ id: string }>('/api/sequences', { method: 'POST', body: JSON.stringify({ name: original, steps: [{ id: `e2e-step-${tag}`, delay_seconds: 86400, sending_time_settings: { type: 'timelimit', from: '09:00', to: '18:00', weekdays: [1, 3, 5] }, status: 'draft', automation_id: null }] }) })
  try {
    await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/sequences`)
    // lista em cartões soltos com cabeçalho de colunas acima; ações no menu ⋮ da linha
    const tabela = page.getByRole('table', { name: 'Sequências' })
    if (info.project.name !== 'mobile') for (const coluna of ['Nome', 'Assinantes', 'Mensagens', 'Taxa de abertura', 'CTR']) await expect(tabela.getByRole('columnheader', { name: coluna, exact: true })).toBeVisible()
    await expect(tabela.getByRole('row').filter({ hasText: original })).toHaveCount(1)
    await expect(page.getByRole('button', { name: `Renomear ${original}`, exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: `Mais ações de ${original}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Renomear', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: 'Novo nome' }).fill(renamed)
    await dialog.getByRole('button', { name: 'Salvar nome', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.reload()
    await page.getByRole('button', { name: `Mais ações de ${renamed}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Duplicar', exact: true }).click()
    await expect(page.getByRole('link', { name: `${renamed} (cópia)`, exact: true })).toBeVisible()
    await page.reload()
    const rows = await api<Array<{ id: string; name: string; subscribers: number; steps: Array<{ id: string; delay_seconds: number }>; stats: { sent: number } }>>('/api/sequences')
    const copy = rows.find(s => s.name === `${renamed} (cópia)` )!
    expect(copy.id).not.toBe(created.id)
    expect(copy.steps[0].id).not.toBe(`e2e-step-${tag}`)
    expect(copy.steps[0].delay_seconds).toBe(86400)
    expect(copy.subscribers).toBe(0)
    expect(copy.stats.sent).toBe(0)
    await expect(page.getByRole('link', { name: renamed, exact: true })).toBeVisible()
    if (process.env.E2E_CAPTURE_SCREENS === '1') await page.screenshot({ path: caminhoPrint(`clone-screens/repintura/05-lista-${info.project.name}.png`), scale: 'css', animations: 'disabled' })
  } finally { sql([`DELETE FROM sequences WHERE workspace_id='${WORKSPACE}' AND (id='${q(created.id)}' OR name='${q(renamed)} (cópia)')`]) }
})


test('criar sequência abre a página de criação, salva sozinha ao dar o nome e aparece na lista', { tag: "@celular" }, async ({ page }, info) => {
  const nome = `Nova ${novoTag()}`
  try {
    await page.goto(`/${WORKSPACE}/automations/sequences`)
    await page.getByRole('button', { name: 'Nova sequência', exact: true }).first().click()
    await expect(page).toHaveURL(/\/automations\/sequences\/new$/)
    await expect(page.getByRole('button', { name: 'Salvar sequência' })).toHaveCount(0)
    await page.getByRole('textbox', { name: 'Nome da sequência', exact: true }).fill(nome)
    // salvamento automático: o aviso do topo troca de "Salvando…" para "Salvo" e a página passa a ser a da sequência criada
    await expect(page.getByText('Salvo', { exact: true })).toBeVisible()
    await expect(page).toHaveURL(/\/automations\/sequences\/(?!new)[^/]+$/)
    if (info.project.name === 'mobile') await page.goBack()
    else await page.getByRole('navigation', { name: 'Você está em' }).getByRole('link', { name: 'Sequências', exact: true }).click()
    await expect(page).toHaveURL(/\/automations\/sequences$/)
    await expect(page.getByRole('link', { name: nome, exact: true })).toBeVisible()
  } finally { sql([`DELETE FROM sequences WHERE workspace_id='${WORKSPACE}' AND name='${q(nome)}'`]) }
})

test('nova resposta própria, agendamento persistido e passo só de ações pelo navegador e motor local', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(120_000)
  const tag = novoTag(), name = `Pós-inscrição ${tag}`, step = `e2e-step-${tag}`, channel = `e2e-channel-${tag}`, contact = `e2e-person-${tag}`, label = `e2e-label-${tag}`
  const created = await api<{ id: string }>('/api/sequences', { method: 'POST', body: JSON.stringify({ name, steps: [{ id: step, delay_seconds: 0, sending_time_settings: { type: 'all' }, status: 'draft', automation_id: null }] }) })
  let automation: string | undefined
  sql([...canalE2eSql(channel), ...contatoSql({ id: contact, canal: channel, nome: 'Pessoa', sobrenome: tag }), `INSERT INTO tags(id,workspace_id,name) VALUES ('${label}','${WORKSPACE}','Estudo ${tag}')`])
  try {
    await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/sequences`)
    await page.getByRole('link', { name: name, exact: true }).click()
    // edição em página própria, com rota própria; voltar retorna à lista
    await expect(page).toHaveURL(new RegExp(`/automations/sequences/${created.id}$`))
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Cancelar', exact: true })).toHaveCount(0)
    if (info.project.name === 'mobile') await page.goBack()
    else await page.getByRole('navigation', { name: 'Você está em' }).getByRole('link', { name: 'Sequências', exact: true }).click()
    await expect(page).toHaveURL(/\/automations\/sequences$/)
    await page.getByRole('link', { name: name, exact: true }).click()
    await page.getByRole('button', { name: 'Criar nova resposta', exact: true }).click({ timeout: 3000 })
    await expect(page).toHaveURL(/\/automations\/(?!sequences)[^/]+$/)
    automation = page.url().split('/').pop()!
    const saved = await api<{ steps: Array<{ automation_id: string; status: string }> }>(`/api/sequences/${created.id}`)
    expect(saved.steps[0]).toMatchObject({ automation_id: automation, status: 'draft' })
    const owned = await api<{ automation: { name: string } }>(`/api/automations/${automation}`)
    expect(owned.automation.name).toContain(name)
    await api(`/api/automations/${automation}/draft`, { method: 'PUT', body: JSON.stringify({ graph: { nodes: [
      { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      { id: 'actions', type: 'action', position: { x: 300, y: 0 }, config: { actions: [{ type: 'add_tag', tag_id: label }] } },
    ], edges: [{ from: 'start', port: 'next', to: 'actions' }] } }) })
    await api(`/api/automations/${automation}/publish`, { method: 'POST' })
    await page.goto(`/${WORKSPACE}/automations/sequences`)
    await page.getByRole('link', { name: name, exact: true }).click()
    const dialog = page.getByRole('main')
    await dialog.getByRole('switch', { name: 'Enviar este passo' }).check()
    await dialog.getByRole('button', { name: 'Editar agendamento do passo 1' }).click()
    await dialog.getByRole('spinbutton', { name: 'Intervalo', exact: true }).fill('2')
    await escolher(page, 'Unidade', 'Horas', dialog)
    await escolher(page, 'Janela de envio', 'Escolher horários e dias', dialog)
    await dialog.getByRole('checkbox', { name: 'segunda-feira no passo 1' }).uncheck()
    await expect(dialog).toContainText('Dias desmarcados podem adiar este passo até a próxima janela permitida.')
    await expect(dialog).toContainText('Após 2 h · 09:00–18:00 · Ter, Qua, Qui, Sex')
    await expect(dialog).toContainText('As alterações são salvas sozinhas; passos já elegíveis poderão sair imediatamente, respeitando a janela e os dias permitidos.')
    if (process.env.E2E_CAPTURE_SCREENS === '1') await page.screenshot({ path: caminhoPrint(`clone-screens/repintura/05-pagina-agendamento-${info.project.name}.png`), scale: 'css', animations: 'disabled' })
    // salvamento automático: sem botão de salvar; espera o motor ter o agendamento novo e o aviso "Salvo"
    await expect(dialog.getByRole('button', { name: 'Salvar sequência' })).toHaveCount(0)
    await expect.poll(async () => (await api<{ steps: Array<{ delay_seconds: number }> }>(`/api/sequences/${created.id}`)).steps[0].delay_seconds, { timeout: 10_000 }).toBe(7200)
    await expect(page.getByText('Salvo', { exact: true })).toBeVisible()
    await page.goto(`/${WORKSPACE}/automations/sequences`)
    const persisted = await api<{ steps: Array<{ delay_seconds: number; sending_time_settings: unknown }> }>(`/api/sequences/${created.id}`)
    expect(persisted.steps[0]).toMatchObject({ delay_seconds: 7200, sending_time_settings: { type: 'timelimit', from: '09:00', to: '18:00', weekdays: [2, 3, 4, 5] } })
    await page.getByRole('link', { name: name, exact: true }).click()
    await expect(dialog).toContainText('Após 2 h · 09:00–18:00 · Ter, Qua, Qui, Sex')
    await dialog.getByRole('button', { name: 'Editar agendamento do passo 1' }).click()
    await dialog.getByRole('spinbutton', { name: 'Intervalo', exact: true }).fill('0')
    await escolher(page, 'Janela de envio', 'Qualquer horário e dia', dialog)
    await expect.poll(async () => (await api<{ steps: Array<{ delay_seconds: number }> }>(`/api/sequences/${created.id}`)).steps[0].delay_seconds, { timeout: 10_000 }).toBe(0)
    await page.goto(`/${WORKSPACE}/automations/sequences`)
    await api('/api/contacts/bulk-sequence', { method: 'POST', body: JSON.stringify({ ids: [contact], sequence_id: created.id }) })
    expect((await fetch(`${ENGINE}/__scheduled?cron=${encodeURIComponent('* * * * *')}`)).status).toBe(200)
    await expect.poll(() => consulta(`SELECT tag_id FROM contact_tags WHERE workspace_id='${WORKSPACE}' AND contact_id='${contact}' AND tag_id='${label}'`).length, { timeout: 30_000 }).toBe(1)
    await page.reload()
    await page.getByRole('link', { name: name, exact: true }).click()
    await expect(dialog.getByRole('group', { name: 'Estatísticas do passo 1' })).toContainText('Enviados: 0')
    if (process.env.E2E_CAPTURE_SCREENS === '1') await dialog.getByRole('textbox', { name: 'Nome da sequência' }).scrollIntoViewIfNeeded()
    if (process.env.E2E_CAPTURE_SCREENS === '1') await page.screenshot({ path: caminhoPrint(`clone-screens/repintura/05-pagina-passos-${info.project.name}.png`), scale: 'css', animations: 'disabled' })
  } finally {
    sql([`DELETE FROM sequences WHERE id='${q(created.id)}'`, `DELETE FROM contacts WHERE id='${contact}'`, `DELETE FROM channels WHERE id='${channel}'`, `DELETE FROM tags WHERE id='${label}'`, `DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND name='Resposta 1 · ${q(name)}'`])
  }
})
