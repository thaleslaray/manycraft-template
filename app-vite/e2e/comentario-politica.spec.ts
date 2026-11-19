import { test, expect } from './fixtures'
import { WORKSPACE, api, consulta, q, sql, passo, novoGatilho } from './helpers'
import { subirInstagramFalso } from './instagram-falso'

// Ficha volta-gatilhos-mensagens/02: a política de disparo do gatilho de comentário é escolhida na tela, volta ao reabrir e vale no próximo comentário.
test('comentário: política de disparo salva na tela, reaberta e aplicada aos comentários seguintes', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(150_000)
  page.setDefaultTimeout(15_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'Esta jornada exige o transporte falso local.').toBeTruthy()
  const fake = await subirInstagramFalso(Number(new URL(catalog.development!.providerApiBase).port), '17840001')
  let connection = '', id = ''
  try {
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'instagram', displayName: 'Política local', credentials: { accessToken: 'e2e-only', accountId: '17840001', appSecret: 'e2e-app-secret' } }) })).connection.id
    expect((await fake.comentar(connection, 'connection-proof', 'Conexão local')).status).toBe(200)
    await expect.poll(async () => (await api<{ status: string }>(`/api/connections/${connection}`)).status, { timeout: 30_000 }).toBe('connected')
    id = (await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: 'Guia por comentário (política)' }) })).id
    await api(`/api/automations/${id}/draft`, { method: 'PUT', body: JSON.stringify({ graph: {
      nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'message', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Seu guia está aqui.' }] } }],
      edges: [{ from: 'trigger', port: 'next', to: 'message' }],
    } }) })
    // Edição em desktop (no celular o editor só mostra o estado); a leitura no celular é conferida no fim.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await passo(page, 'Gatilho').click({ position: { x: 40, y: 16 } })
    await novoGatilho(page, 'Instagram', /Comentários na publicação ou Reel/)
    await page.getByLabel('Nome do gatilho').fill('Pedido do guia')
    await page.getByRole('combobox', { name: 'Conexão', exact: true }).click()
    await page.getByRole('option', { name: 'Política local', exact: true }).click()
    const created = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/automations/${id}/triggers`))
    await page.getByRole('button', { name: 'Criar gatilho', exact: true }).click()
    expect((await created).status()).toBe(201)
    const trigger = (await (await created).json() as { id: string }).id
    await page.getByRole('button', { name: 'Escolher publicação', exact: true }).click()
    await page.getByRole('option', { name: /Guia para organizar seus estudos/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Escolher', exact: true }).click()
    await page.getByRole('textbox', { name: 'Nova palavra: Palavras que o comentário deve ter', exact: true }).fill('quero')
    await page.getByRole('textbox', { name: 'Nova palavra: Palavras que o comentário deve ter', exact: true }).press('Enter')
    const politica = page.getByRole('combobox', { name: 'Política de disparo', exact: true })
    await expect(politica).toContainText('Sempre')
    await politica.click()
    await expect(page.getByRole('option')).toHaveText(['Sempre', 'Uma vez a cada 24 horas', 'Uma vez por contato'])
    await page.getByRole('option', { name: 'Uma vez por contato', exact: true }).click()
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    await expect(page.getByText('Gatilho salvo', { exact: true })).toBeVisible()
    expect(consulta<{ repeat_mode: string }>(`SELECT repeat_mode FROM triggers WHERE id='${q(trigger)}'`)[0].repeat_mode).toBe('once')
    // Reabrir mostra o valor gravado.
    await page.reload()
    await passo(page, 'Gatilho').click({ position: { x: 40, y: 16 } })
    await expect(politica).toContainText('Uma vez por contato')
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Ao vivo', { exact: true })).toBeVisible()
    await api(`/api/automations/${id}/triggers/${trigger}`, { method: 'PATCH', body: JSON.stringify({ state: 'active' }) })
    await page.reload()
    const privadas = () => fake.chamadas.filter(c => c.path.endsWith('/messages')).length
    const execucoes = () => consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs WHERE channel_id='${q(connection)}'`)[0]?.n
    let processados = consulta<{ n: number }>(`SELECT count(*) n FROM inbound_events WHERE channel_id='${q(connection)}' AND planned_at IS NOT NULL`)[0]?.n ?? 0
    const comentar = async (comment: string) => {
      expect((await fake.comentar(connection, comment, 'eu quero o guia')).status).toBe(200)
      processados++
      await expect(async () => expect(consulta<{ n: number }>(`SELECT count(*) n FROM inbound_events WHERE channel_id='${q(connection)}' AND planned_at IS NOT NULL`)[0]?.n).toBe(processados)).toPass({ timeout: 30_000 })
    }
    // Uma vez por contato: o segundo comentário da mesma pessoa (outro comentário) não dispara.
    await comentar('comment-politica-1')
    await expect.poll(privadas, { timeout: 30_000 }).toBe(1)
    await comentar('comment-politica-2')
    expect(execucoes()).toBe(1)
    expect(privadas()).toBe(1)
    // Troca para Sempre na tela, com o gatilho ligado: o próximo comentário da mesma pessoa dispara.
    // Ao vivo o editor abre a versão publicada: "Editar" volta ao rascunho, onde o gatilho é configurado.
    await passo(page, 'Gatilho').click({ position: { x: 40, y: 16 } })
    await page.getByRole('button', { name: 'Editar', exact: true }).first().click()
    await page.getByRole('button', { name: 'Configurar Pedido do guia', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Gatilho ativo' })).toBeChecked()
    await politica.click()
    await page.getByRole('option', { name: 'Sempre', exact: true }).click()
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    await expect(page.getByText('Gatilho salvo', { exact: true }).last()).toBeVisible()
    expect(consulta<{ repeat_mode: string }>(`SELECT repeat_mode FROM triggers WHERE id='${q(trigger)}'`)[0].repeat_mode).toBe('every_time')
    await comentar('comment-politica-3')
    await expect.poll(privadas, { timeout: 30_000 }).toBe(2)
    expect(execucoes()).toBe(2)
    await page.reload()
    await passo(page, 'Gatilho').click({ position: { x: 40, y: 16 } })
    await expect(politica).toContainText('Sempre')
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.getByRole('list', { name: 'Passos da automação' })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
    await page.screenshot({ path: info.outputPath('comentario-politica.png'), scale: 'css' })
  } finally {
    if (id) sql([`DELETE FROM automations WHERE id='${q(id)}'`])
    if (connection) sql([`DELETE FROM contacts WHERE id IN (SELECT contact_id FROM contact_channels WHERE channel_id='${q(connection)}')`, `DELETE FROM inbound_events WHERE channel_id='${q(connection)}'`, `DELETE FROM channels WHERE id='${q(connection)}'`])
    await fake.fechar()
  }
})
