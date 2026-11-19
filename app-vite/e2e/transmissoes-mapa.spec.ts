import { test, expect } from './fixtures'
import { WORKSPACE, acaoDoTopo, api, caminhoPrint, consulta, escolher, novoTag, q, sql, textoDoPasso } from './helpers'
import { subirTelegramFalso } from './telegram-falso'

test('monta a transmissão no mapa de fluxo, salva, envia e confere a entrega dos dois passos', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'O mapa de fluxo é montado na tela ampla.')
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1864, height: 1033 })
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'Provedor falso obrigatório nesta jornada').toBeTruthy()
  const t = novoTag(), botId = 9300000 + Math.floor(Math.random() * 500000), token = `${botId}:E2E-${t}`
  const fake = await subirTelegramFalso(Number(new URL(catalog.development!.providerApiBase).port), { [token]: { id: botId, username: `mapa_${t}` } })
  const name = `Mapa de passos ${t}`, primeiro = `Primeiro passo ${t}`, segundo = `Segundo passo ${t}`
  let connection = ''
  try {
    const connected = await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', displayName: `Bot do mapa ${t}`, credentials: { botToken: token } }) })
    connection = connected.connection.id
    sql([
      `INSERT INTO contacts(id,workspace_id,first_name) VALUES ('e2e-mapa-${t}','${WORKSPACE}','Pessoa do mapa')`,
      `INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('e2e-mapa-${t}-cc','${WORKSPACE}','e2e-mapa-${t}','${connection}','5503001',1)`,
    ])
    await page.goto(`/${WORKSPACE}/broadcasts`)
    await acaoDoTopo(page, 'Nova transmissão')
    await page.getByLabel('Nome da transmissão').fill(name)
    await escolher(page, 'Canal conectado', `Bot do mapa ${t}`)
    const mapa = page.getByRole('application', { name: 'Mapa do conteúdo da transmissão' })
    // O início é o envio: não há gatilho no mapa, só o passo de mensagem.
    await expect(mapa.getByRole('group', { name: /^Passo Gatilho/ })).toHaveCount(0)
    await (await textoDoPasso(page)).fill(primeiro)
    // Com o primeiro passo aberto, o novo passo nasce ligado a ele.
    await page.getByRole('button', { name: 'Adicionar passo', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Mensagem', exact: true }).click()
    await page.getByRole('textbox', { name: 'Texto do bloco 1', exact: true }).fill(segundo)
    await expect(mapa.getByRole('group', { name: /^Passo Mensagem/ })).toHaveCount(2)
    await acaoDoTopo(page, 'Salvar rascunho')
    await expect(page).toHaveURL(/\/broadcasts$/)
    const salvo = consulta<{ flow: string; first_node_id: string }>(`SELECT flow,first_node_id FROM broadcasts WHERE workspace_id='${WORKSPACE}' AND name='${q(name)}'`)[0]
    expect(JSON.parse(salvo.flow).nodes).toHaveLength(2)
    // Reabre o rascunho: os dois passos voltam no mapa.
    await page.getByRole('button', { name: `Editar ${name}`, exact: true }).click()
    await expect(mapa.getByRole('group', { name: /^Passo Mensagem/ })).toHaveCount(2)
    await expect(mapa.getByRole('group', { name: new RegExp(`^Passo Mensagem: ${primeiro}`) })).toBeVisible()
    await expect(mapa.getByRole('group', { name: new RegExp(`^Passo Mensagem: ${segundo}`) })).toBeVisible()
    await acaoDoTopo(page, 'Enviar agora')
    await page.getByRole('button', { name: 'Confirmar envio', exact: true }).click()
    await expect(page).toHaveURL(/\/broadcasts$/)
    await expect.poll(() => fake.enviadas().filter(m => m.chat_id === '5503001').map(m => m.text), { timeout: 40_000 }).toEqual([primeiro, segundo])
    const id = consulta<{ id: string }>(`SELECT id FROM broadcasts WHERE workspace_id='${WORKSPACE}' AND name='${q(name)}'`)[0].id
    await expect.poll(() => api(`/api/broadcasts/${id}`), { timeout: 30_000 }).toMatchObject({ status: 'sent', metrics: { sent: 1 } })
    // Relatório: página própria com o fluxo enviado, só leitura, e os números em cada passo.
    await page.goto(`/${WORKSPACE}/broadcasts/${id}/report`)
    await expect(page.getByRole('complementary', { name: 'Principais métricas' })).toBeVisible()
    const enviado = page.getByRole('application', { name: 'Mapa do fluxo enviado' })
    await expect(enviado.getByText('Você envia uma transmissão')).toBeVisible()
    await expect(enviado.getByRole('group', { name: /^Passo Mensagem/ })).toHaveCount(2)
    const numeros = enviado.getByRole('group', { name: 'Métricas da mensagem' })
    await expect(numeros).toHaveCount(2)
    for (const n of [0, 1]) await expect(numeros.nth(n)).toHaveText(/^1\s*Enviado$/)
    await expect(page.getByRole('button', { name: 'Adicionar passo', exact: true })).toHaveCount(0)
    // O mapa do relatório fica centrado na horizontal e no terço de cima, como no original (ler a classe só serve para medir).
    await expect.poll(async () => {
      const mapa = (await page.locator('.react-flow').boundingBox())!
      const caixas = await page.locator('.react-flow__node').evaluateAll(els => els.map(el => el.getBoundingClientRect()).map(r => ({ x: r.x, y: r.y, w: r.width, h: r.height })))
      const meioX = (Math.min(...caixas.map(c => c.x)) + Math.max(...caixas.map(c => c.x + c.w))) / 2
      const topo = Math.min(...caixas.map(c => c.y)) - mapa.y
      return topo > 0 && topo < mapa.height / 3 ? Math.abs(meioX - (mapa.x + mapa.width / 2)) : 999
    }).toBeLessThan(40)
    await page.screenshot({ path: caminhoPrint('transmissoes/relatorio-1864x1033.png') })
  } finally {
    const copies = consulta<{ automation_id: string }>(`SELECT automation_id FROM broadcasts WHERE workspace_id='${WORKSPACE}' AND name='${q(name)}' AND automation_id IS NOT NULL`)
    try { sql([
      `DELETE FROM broadcasts WHERE workspace_id='${WORKSPACE}' AND name='${q(name)}'`,
      `DELETE FROM contacts WHERE id='e2e-mapa-${t}'`,
      `DELETE FROM automations WHERE id IN (${copies.map(row => `'${q(row.automation_id)}'`).join(',') || "''"})`,
      `DELETE FROM inbound_events WHERE channel_id='${q(connection)}'`, `DELETE FROM channels WHERE id='${q(connection)}'`,
    ]) } finally { await fake.fechar() }
  }
})
