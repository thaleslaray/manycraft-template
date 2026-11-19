import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ENGINE, WORKSPACE, api, consulta, novoTag, q, sql, escolherCanalDoPasso, abrirAcao } from './helpers'
import { subirTelegramFalso, type TelegramFalso } from './telegram-falso'

// Ficha volta-gatilhos-mensagens/08: a ação Definir valor de campo oferece as operações do tipo do campo (número: somar e subtrair;
// texto: definir e limpar; data: somar dias e definir como agora) e o motor aplica cada uma quando o fluxo roda.
async function escolha(page: Page, rotulo: string, opcao: string) {
  await page.getByRole('combobox', { name: rotulo, exact: true }).click()
  await page.getByRole('option', { name: opcao, exact: true }).click()
}

test('definir campo com operações: escolher no editor, reabrir e ver o motor somar, subtrair, limpar e gravar a data', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(150_000)
  page.setDefaultTimeout(15_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'A jornada exige o transporte falso local.').toBeTruthy()
  const providerBase = new URL(catalog.development!.providerApiBase)
  expect(['localhost', '127.0.0.1']).toContain(providerBase.hostname)
  const tag = novoTag(), bot = 5_000_000 + Math.floor(Math.random() * 999_999), word = `pontos${tag}`, resposta = `Pontos atualizados ${tag}`
  let fake: TelegramFalso | undefined, connection: string | undefined, automation: string | undefined
  const fields: string[] = []
  try {
    const pontos = (await api<{ id: string }>('/api/fields', { method: 'POST', body: JSON.stringify({ name: `Pontos ${tag}`, type: 'number' }) })).id
    const apelido = (await api<{ id: string }>('/api/fields', { method: 'POST', body: JSON.stringify({ name: `Apelido ${tag}`, type: 'text' }) })).id
    const retorno = (await api<{ id: string }>('/api/fields', { method: 'POST', body: JSON.stringify({ name: `Retorno ${tag}`, type: 'date' }) })).id
    fields.push(pontos, apelido, retorno)
    fake = await subirTelegramFalso(Number(providerBase.port), { [`${bot}:e2e-${tag}`]: { id: bot, username: `e2e_${tag}` } })
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', displayName: `e2e Campos ${tag}`, credentials: { botToken: `${bot}:e2e-${tag}` } }) })).connection.id
    automation = (await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: `Pontos de fidelidade ${tag}` }) })).id
    const trigger = await api<{ id: string }>(`/api/automations/${automation}/triggers`, { method: 'POST', body: JSON.stringify({ name: `Pontos ${tag}`, connection_id: connection, node_id: 'trigger', words: [word], rule: 'is' }) })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${automation}`)
    await page.getByRole('button', { name: 'Adicionar passo', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Ações', exact: true }).click()
    const novaAcao = async (n: number, campo: string) => {
      await page.getByRole('button', { name: 'Adicionar ação', exact: true }).click()
      await escolha(page, `Ação ${n}`, 'Definir valor de campo')
      await escolha(page, 'Campo de contato', campo)
    }
    // Número: as operações são as de número.
    await novaAcao(1, `Pontos ${tag}`)
    await page.getByRole('combobox', { name: 'Operação', exact: true }).click()
    await expect(page.getByRole('option')).toHaveText(['Definir valor', 'Somar', 'Subtrair'])
    await page.getByRole('option', { name: 'Somar', exact: true }).click()
    await page.getByRole('textbox', { name: 'Quantidade', exact: true }).fill('5')
    await novaAcao(2, `Pontos ${tag}`)
    await escolha(page, 'Operação', 'Subtrair')
    await page.getByRole('textbox', { name: 'Quantidade', exact: true }).fill('2')
    // Texto: definir e limpar.
    await novaAcao(3, `Apelido ${tag}`)
    await page.getByRole('combobox', { name: 'Operação', exact: true }).click()
    await expect(page.getByRole('option')).toHaveText(['Definir valor', 'Limpar valor'])
    await page.getByRole('option', { name: 'Limpar valor', exact: true }).click()
    await expect(page.getByText('Remove o valor salvo neste campo para o contato.')).toBeVisible()
    // Data: somar dias e definir como agora.
    await novaAcao(4, `Retorno ${tag}`)
    await page.getByRole('combobox', { name: 'Operação', exact: true }).click()
    await expect(page.getByRole('option')).toHaveText(['Definir valor', 'Somar dias', 'Definir como agora'])
    await page.getByRole('option', { name: 'Definir como agora', exact: true }).click()
    await page.getByRole('button', { name: 'Adicionar passo', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Mensagem', exact: true }).click()
    await escolherCanalDoPasso(page, 'Telegram')
    await page.getByRole('textbox', { name: 'Texto do bloco 1' }).fill(resposta)
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByText('Rascunho salvo', { exact: true })).toBeVisible()
    const actions = (await api<{ automation: { draft_graph: { nodes: { type: string; config: { actions?: unknown[] } }[] } } }>(`/api/automations/${automation}`))
      .automation.draft_graph.nodes.find(n => n.type === 'action')?.config.actions
    expect(actions).toEqual([
      { type: 'set_custom_field_value', field_id: pontos, operation: 'add', value: 5 },
      { type: 'set_custom_field_value', field_id: pontos, operation: 'subtract', value: 2 },
      { type: 'set_custom_field_value', field_id: apelido, operation: 'clear' },
      { type: 'set_custom_field_value', field_id: retorno, operation: 'set_now' },
    ])
    // Reabrir mostra a operação e a quantidade gravadas.
    await page.reload()
    await page.locator('.react-flow__node-action').click()
    await abrirAcao(page, 2)
    await expect(page.getByRole('combobox', { name: 'Operação', exact: true })).toContainText('Subtrair')
    await expect(page.getByRole('textbox', { name: 'Quantidade', exact: true })).toHaveValue('2')
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Ao vivo', { exact: true })).toBeVisible()
    await api(`/api/automations/${automation}/triggers/${trigger.id}`, { method: 'PATCH', body: JSON.stringify({ state: 'active' }) })

    const hook = fake.webhook()!
    let serial = Date.now()
    const enviar = async () => {
      const event = ++serial
      const response = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token }, body: JSON.stringify({ update_id: event, message: { message_id: event, from: { id: bot + 1, first_name: `Cliente${tag}` }, chat: { id: bot + 1, type: 'private' }, text: word } }) })
      expect(response.status).toBe(200)
    }
    const valor = (field: string) => consulta<{ value: string }>(`SELECT v.value FROM contact_field_values v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.contact_id=v.contact_id
      WHERE v.workspace_id='${WORKSPACE}' AND cc.channel_id='${q(connection!)}' AND v.field_id='${q(field)}'`)[0]?.value
    // Campo vazio conta como zero: 0 + 5 - 2 = 3. A data é a de hoje.
    await enviar()
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([resposta])
    await expect.poll(() => valor(pontos), { timeout: 30_000 }).toBe('3')
    expect(valor(apelido)).toBeUndefined()
    const hoje = new Date().toISOString().slice(0, 10), ontem = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    expect([hoje, ontem].map(d => JSON.stringify(d))).toContain(valor(retorno))
    // Com apelido salvo, a segunda passagem limpa o apelido e soma sobre o valor anterior: 3 + 5 - 2 = 6.
    const contato = consulta<{ contact_id: string }>(`SELECT contact_id FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND channel_id='${q(connection)}'`)[0].contact_id
    sql([`INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES ('${WORKSPACE}','${q(contato)}','${q(apelido)}','"Ana"')`])
    expect(valor(apelido)).toBe('"Ana"')
    await enviar()
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([resposta, resposta])
    await expect.poll(() => valor(pontos), { timeout: 30_000 }).toBe('6')
    expect(valor(apelido)).toBeUndefined()
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.getByRole('list', { name: 'Passos da automação' })).toContainText(`Soma 5 em Pontos ${tag}`)
      await expect(page.getByRole('list', { name: 'Passos da automação' })).toContainText(`Define Retorno ${tag} como agora`)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
    await page.screenshot({ path: info.outputPath('definir-campo-operacoes.png'), scale: 'css' })
  } finally {
    await fake?.fechar()
    const ws = `workspace_id='${WORKSPACE}'`
    if (connection) sql([`DELETE FROM contacts WHERE ${ws} AND id IN (SELECT contact_id FROM contact_channels WHERE ${ws} AND channel_id='${q(connection)}')`, `DELETE FROM inbound_events WHERE ${ws} AND channel_id='${q(connection)}'`, `DELETE FROM channels WHERE ${ws} AND id='${q(connection)}'`])
    if (automation) sql([`DELETE FROM automations WHERE ${ws} AND id='${q(automation)}'`])
    if (fields.length) sql([`DELETE FROM custom_fields WHERE ${ws} AND id IN (${fields.map(f => `'${q(f)}'`).join(',')})`])
  }
})
