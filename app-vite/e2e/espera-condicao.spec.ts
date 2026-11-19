import type { Page, TestInfo } from '@playwright/test'
import { test, expect } from './fixtures'
import { api, conexaoConectada, consulta, ENGINE, gatilhoDeRascunho, novoTag, q, sql, WORKSPACE, caminhoPrint, abrirMaisOpcoes } from './helpers'
import { subirTelegramFalso, type TelegramFalso } from './telegram-falso'

async function escolha(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

async function captura(page: Page, info: TestInfo, tela: string) {
  const selected = page.locator('.react-flow__node.selected').first()
  const selectedId = await selected.count() ? await selected.getAttribute('data-id') : null
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 })
  if (info.project.name === 'mobile' && selectedId) {
    const steps = page.getByRole('list', { name: 'Passos da automação' })
    await expect(steps).toBeVisible()
    const resumo: Record<string, string> = { 'espera-janela': '09:00–17:30', 'espera-data': 'Data da reserva', 'espera-data-fixa': '24/10/2030', 'condicao-sequencia': 'Preparação', 'condicao-horario': '08:00–20:00', 'condicao-data': 'Data do evento', 'condicao-data-fixa': '24/10/2030' }
    if (resumo[tela]) await expect(steps).toContainText(resumo[tela])
  }
  const name = `22-${tela}-${info.project.name}.png`
  const path = process.env.E2E_CAPTURE_SCREENS === '1' ? caminhoPrint(`clone-screens/${name}`) : info.outputPath(name)
  await page.screenshot({ path, scale: 'css', animations: 'disabled' })
  await page.setViewportSize({ width: 1440, height: 900 })
  if (info.project.name === 'mobile' && selectedId) await page.locator(`.react-flow__node[data-id="${selectedId}"]`).click()
}

type Graph = { nodes: { id: string; type: string; config: Record<string, unknown> }[] }
async function config(id: string, node: string) {
  const detail = await api<{ automation: { draft_graph: Graph } }>(`/api/automations/${id}`)
  return detail.automation.draft_graph.nodes.find(item => item.id === node)?.config
}

async function salvar(page: Page) {
  await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
  await expect(page.getByText('Rascunho salvo', { exact: true })).toBeVisible()
}

test('espera por período, janela e data com deslocamento persiste e publica no motor local', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(120_000)
  const tag = novoTag(), id = `e2e-wait-${tag}`, field = `e2e-date-${tag}`
  const graph = { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'delay', type: 'smart_delay', position: { x: 250, y: 0 }, config: { duration: { value: 1, unit: 'minutes' } } },
    { id: 'message', type: 'message', position: { x: 500, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Sua data foi reservada.' }] } },
  ], edges: [{ from: 'trigger', port: 'next', to: 'delay' }, { from: 'delay', port: 'next', to: 'message' }] }
  sql([
    `INSERT INTO custom_fields(id,workspace_id,scope,name,type) VALUES ('${field}','${WORKSPACE}','contact','Data da reserva ${tag}','date')`,
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','Espera com agenda ${tag}','${q(JSON.stringify(graph))}')`,
  ])
  // Publicar sem gatilho é barrado: este gatilho nasce desligado só para a publicação passar.
  await gatilhoDeRascunho(id, await conexaoConectada(), `espera${tag}`)
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await page.locator('.react-flow__node[data-id="delay"]').click()
    await expect(page.getByRole('tab', { name: 'Duração', exact: true })).toBeVisible()
    await page.getByRole('spinbutton', { name: 'Aguardar por', exact: true }).fill('2')
    await escolha(page, 'Unidade', 'horas')
    await page.getByRole('switch', { name: 'Enviar durante um período determinado', exact: true }).click()
    await page.getByLabel('Continuar a partir de', { exact: true }).fill('09:00')
    await page.getByLabel('Continuar até', { exact: true }).fill('17:30')
    for (const day of ['Sáb', 'Dom']) {
      const button = page.getByRole('button', { name: day, exact: true })
      if (await button.getAttribute('aria-pressed') === 'true') await button.click()
    }
    await abrirMaisOpcoes(page)
    await page.getByRole('combobox', { name: 'Fuso horário', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Buscar fuso horário', exact: true }).fill('Sao Paulo')
    await page.getByRole('option', { name: 'America/Sao Paulo', exact: true }).click()
    await salvar(page)
    await expect.poll(() => config(id, 'delay')).toMatchObject({ duration: { value: 2, unit: 'hours' }, window: { from: '09:00', to: '17:30', days: [1, 2, 3, 4, 5] }, timezone: 'America/Sao_Paulo' })
    await page.reload()
    await page.locator('.react-flow__node[data-id="delay"]').click()
    await expect(page.getByLabel('Continuar até', { exact: true })).toHaveValue('17:30')
    await captura(page, info, 'espera-janela')
    await page.getByRole('tab', { name: 'Data', exact: true }).click()
    await escolha(page, 'Origem da data', 'Data definida')
    await page.getByLabel('Data e hora', { exact: true }).fill('2030-10-24T10:00')
    await page.getByRole('spinbutton', { name: 'Deslocamento', exact: true }).fill('2')
    await escolha(page, 'Unidade do deslocamento', 'dias')
    await escolha(page, 'Aplicar deslocamento', 'Antes')
    await salvar(page)
    await expect.poll(() => config(id, 'delay')).toMatchObject({ mode: 'date', date: { kind: 'specific' }, offset: { value: 2, unit: 'days', direction: 'before' } })
    await page.reload()
    await page.locator('.react-flow__node[data-id="delay"]').click()
    await expect(page.getByLabel('Data e hora', { exact: true })).toHaveValue('2030-10-24T10:00')
    await captura(page, info, 'espera-data-fixa')
    await escolha(page, 'Origem da data', 'Campo de data')
    await escolha(page, 'Campo de data', `Data da reserva ${tag}`)
    await salvar(page)
    await expect.poll(() => config(id, 'delay')).toMatchObject({ mode: 'date', date: { kind: 'field', field_id: field }, offset: { value: 2, unit: 'days', direction: 'before' } })
    await page.reload()
    await page.locator('.react-flow__node[data-id="delay"]').click()
    await expect(page.getByRole('combobox', { name: 'Campo de data', exact: true })).toContainText(`Data da reserva ${tag}`)
    await captura(page, info, 'espera-data')
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Ao vivo', { exact: true })).toBeVisible()
  } finally {
    sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${id}'`, `DELETE FROM custom_fields WHERE workspace_id='${WORKSPACE}' AND id='${field}'`])
  }
})

test('condição por sequência, horário e data mantém configurações após recarregar e publica', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(120_000)
  const tag = novoTag(), id = `e2e-condition-${tag}`, field = `e2e-date-condition-${tag}`, sequence = `e2e-sequence-${tag}`
  const graph = { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'condition', type: 'condition', position: { x: 250, y: 0 }, config: { match: 'all', rules: [] } },
    { id: 'message', type: 'message', position: { x: 500, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Condição atendida.' }] } },
  ], edges: [{ from: 'trigger', port: 'next', to: 'condition' }, { from: 'condition', port: 'true', to: 'message' }, { from: 'condition', port: 'false', to: 'message' }] }
  sql([
    `INSERT INTO custom_fields(id,workspace_id,scope,name,type) VALUES ('${field}','${WORKSPACE}','contact','Data do evento ${tag}','date')`,
    `INSERT INTO sequences(id,workspace_id,name) VALUES ('${sequence}','${WORKSPACE}','Preparação ${tag}')`,
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','Condição avançada ${tag}','${q(JSON.stringify(graph))}')`,
  ])
  // Publicar sem gatilho é barrado: este gatilho nasce desligado só para a publicação passar.
  await gatilhoDeRascunho(id, await conexaoConectada(), `espera${tag}`)
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await page.locator('.react-flow__node[data-id="condition"]').click()
    await page.getByRole('button', { name: 'Adicionar regra', exact: true }).click()
    await escolha(page, 'Regra 1', 'Inscrição em sequência')
    await escolha(page, 'Sequência', `Preparação ${tag}`)
    await escolha(page, 'Comparação', 'Não pertence à sequência')
    await salvar(page)
    await expect.poll(() => config(id, 'condition')).toMatchObject({ rules: [{ type: 'sequence', sequence_id: sequence, operator: 'not_has' }] })
    await page.reload()
    await page.locator('.react-flow__node[data-id="condition"]').click()
    await expect(page.getByRole('combobox', { name: 'Sequência', exact: true })).toContainText(`Preparação ${tag}`)
    await captura(page, info, 'condicao-sequencia')
    await escolha(page, 'Regra 1', 'Horário atual')
    await page.getByLabel('Continuar a partir de', { exact: true }).fill('08:00')
    await page.getByLabel('Continuar até', { exact: true }).fill('20:00')
    await page.getByRole('combobox', { name: 'Fuso horário', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Buscar fuso horário', exact: true }).fill('New York')
    await page.getByRole('option', { name: 'America/New York', exact: true }).click()
    await salvar(page)
    await expect.poll(() => config(id, 'condition')).toMatchObject({ rules: [{ type: 'current_time', window: { from: '08:00', to: '20:00' }, timezone: 'America/New_York' }] })
    await page.reload()
    await page.locator('.react-flow__node[data-id="condition"]').click()
    await expect(page.getByLabel('Continuar a partir de', { exact: true })).toHaveValue('08:00')
    await captura(page, info, 'condicao-horario')
    await escolha(page, 'Regra 1', 'Comparar datas')
    await escolha(page, 'Campo de data', `Data do evento ${tag}`)
    await escolha(page, 'Comparação', 'Depois de')
    await escolha(page, 'Origem da data comparada', 'Data definida')
    await page.getByLabel('Data e hora', { exact: true }).fill('2030-10-24T09:00')
    await page.getByRole('spinbutton', { name: 'Deslocamento', exact: true }).fill('3')
    await escolha(page, 'Unidade do deslocamento', 'dias')
    await escolha(page, 'Aplicar deslocamento', 'Depois')
    await page.getByRole('combobox', { name: 'Fuso horário', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Buscar fuso horário', exact: true }).fill('Sao Paulo')
    await page.getByRole('option', { name: 'America/Sao Paulo', exact: true }).click()
    await salvar(page)
    await expect.poll(() => config(id, 'condition')).toMatchObject({ rules: [{ type: 'date', field_id: field, operator: 'after', compare: { kind: 'specific' }, offset: { value: 3, unit: 'days', direction: 'after' }, timezone: 'America/Sao_Paulo' }] })
    await page.reload()
    await page.locator('.react-flow__node[data-id="condition"]').click()
    await expect(page.getByLabel('Data e hora', { exact: true })).toHaveValue('2030-10-24T09:00')
    await captura(page, info, 'condicao-data-fixa')
    await escolha(page, 'Origem da data comparada', 'Campo de data')
    await escolha(page, 'Campo de data comparada', `Data do evento ${tag}`)
    await salvar(page)
    await expect.poll(() => config(id, 'condition')).toMatchObject({ rules: [{ type: 'date', compare: { kind: 'field', field_id: field }, offset: { value: 3, unit: 'days', direction: 'after' } }] })
    await page.reload()
    await page.locator('.react-flow__node[data-id="condition"]').click()
    await expect(page.getByRole('combobox', { name: 'Campo de data comparada', exact: true })).toContainText(`Data do evento ${tag}`)
    await captura(page, info, 'condicao-data')
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Ao vivo', { exact: true })).toBeVisible()
  } finally {
    sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${id}'`, `DELETE FROM custom_fields WHERE workspace_id='${WORKSPACE}' AND id='${field}'`, `DELETE FROM sequences WHERE workspace_id='${WORKSPACE}' AND id='${sequence}'`])
  }
})


test('espera e condição publicadas continuam o fluxo usando somente o provedor falso local', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(150_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'Esta jornada exige o transporte falso local.').toBeTruthy()
  const provider = new URL(catalog.development!.providerApiBase)
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(provider.hostname)
  const tag = novoTag(), id = `e2e-wait-run-${tag}`, seq = `e2e-wait-seq-${tag}`, word = `agenda${tag}`, reply = `Agenda confirmada ${tag}`
  const bot = 9_000_000 + Math.floor(Math.random() * 999_999)
  let fake: TelegramFalso | undefined, connection: string | undefined
  const window = { from: '00:00', to: '23:59', days: [0, 1, 2, 3, 4, 5, 6] }
  const graph = { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'delay', type: 'smart_delay', position: { x: 200, y: 0 }, config: { mode: 'duration', duration: { value: 1, unit: 'seconds' }, window, timezone: 'America/Sao_Paulo' } },
    { id: 'condition', type: 'condition', position: { x: 400, y: 0 }, config: { match: 'all', rules: [{ type: 'current_time', window, timezone: 'America/New_York' }, { type: 'sequence', sequence_id: seq, operator: 'not_has' }] } },
    { id: 'message', type: 'message', position: { x: 600, y: 0 }, config: { blocks: [{ kind: 'text', text: reply }] } },
  ], edges: [{ from: 'trigger', port: 'next', to: 'delay' }, { from: 'delay', port: 'next', to: 'condition' }, { from: 'condition', port: 'true', to: 'message' }] }
  try {
    fake = await subirTelegramFalso(Number(provider.port), { [`${bot}:e2e-${tag}`]: { id: bot, username: `e2e_${tag}` } })
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', displayName: `e2e Agenda ${tag}`, credentials: { botToken: `${bot}:e2e-${tag}` } }) })).connection.id
    sql([`INSERT INTO sequences(id,workspace_id,name) VALUES ('${seq}','${WORKSPACE}','Agenda ${tag}')`, `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','Agenda em execução ${tag}','${q(JSON.stringify(graph))}')`])
    // Publicar sem gatilho é barrado: este gatilho nasce desligado só para a publicação passar.
    await gatilhoDeRascunho(id, connection, `agenda${tag}`)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await page.locator('.react-flow__node[data-id="delay"]').click()
    await expect(page.getByRole('switch', { name: 'Enviar durante um período determinado', exact: true })).toBeChecked()
    await page.getByRole('spinbutton', { name: 'Aguardar por', exact: true }).fill('8')
    await salvar(page)
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Ao vivo', { exact: true })).toBeVisible()
    const keyword = await api<{ id: string }>('/api/keywords', { method: 'POST', body: JSON.stringify({ name: `Agenda ${tag}`, channel: 'telegram', automation_id: id, active: true, rules: [{ condition: 'equals', words: [word] }] }) })
    sql([`UPDATE triggers SET channel_id='${q(connection)}' WHERE workspace_id='${WORKSPACE}' AND id=(SELECT trigger_id FROM keywords WHERE workspace_id='${WORKSPACE}' AND id='${q(keyword.id)}')`])
    const hook = fake.webhook()!, event = Date.now()
    const response = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token }, body: JSON.stringify({ update_id: event, message: { message_id: event, from: { id: bot + 1, first_name: `Agenda${tag}` }, chat: { id: bot + 1, type: 'private' }, text: word } }) })
    expect(response.status).toBe(200)
    await expect.poll(() => fake!.enviadas().map(message => message.text), { timeout: 45_000 }).toEqual([reply])
    await expect(async () => {
      expect(consulta<{ status: string }>(`SELECT r.status FROM flow_runs r JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id WHERE r.workspace_id='${WORKSPACE}' AND v.automation_id='${id}'`)[0]?.status).toBe('done')
    }).toPass({ timeout: 30_000 })
    await page.goto(`/${WORKSPACE}/inbox`)
    await page.getByRole('textbox', { name: /Buscar conversa/ }).fill(`Agenda${tag}`)
    await page.getByRole('button', { name: new RegExp(`Agenda${tag}, Telegram`) }).click()
    await expect(page.getByRole('log', { name: 'Histórico da conversa' })).toContainText(reply)
    await captura(page, info, 'execucao-local')
    // A mesma conexão falsa recebe uma ficha efetiva com janela. O nome Telegram não deve contornar essa regra.
    sql([`UPDATE channels SET capabilities_override='{"window":{"standardHours":24,"outside":"human_agent_only"}}' WHERE workspace_id='${WORKSPACE}' AND id='${q(connection)}'`, `UPDATE contact_channels SET window_expires_at=${Date.now() + 86_400_000} WHERE workspace_id='${WORKSPACE}' AND channel_id='${q(connection)}'`])
    const nextEvent = event + 1
    const blocked = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token }, body: JSON.stringify({ update_id: nextEvent, message: { message_id: nextEvent, from: { id: bot + 1, first_name: `Agenda${tag}` }, chat: { id: bot + 1, type: 'private' }, text: word } }) })
    expect(blocked.status).toBe(200)
    await expect(async () => {
      expect(consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs r JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id WHERE r.workspace_id='${WORKSPACE}' AND v.automation_id='${id}' AND r.status='waiting_delay'`)[0]?.n).toBe(1)
    }).toPass({ timeout: 30_000 })
    sql([`UPDATE contact_channels SET window_expires_at=0 WHERE workspace_id='${WORKSPACE}' AND channel_id='${q(connection)}'`])
    await expect(async () => {
      expect(consulta<{ error: string }>(`SELECT r.error FROM flow_runs r JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id WHERE r.workspace_id='${WORKSPACE}' AND v.automation_id='${id}' AND r.status='failed'`)[0]?.error).toBe('channel_outside_window')
    }).toPass({ timeout: 30_000 })
    expect(fake.enviadas().map(message => message.text)).toEqual([reply])
    await page.reload()
    await expect(page.getByRole('log', { name: 'Histórico da conversa' })).toContainText('Envio barrado: a janela de 24 horas da conexão encerrou.')
    await captura(page, info, 'janela-barrada')
  } finally {
    await fake?.fechar()
    const ws = `workspace_id='${WORKSPACE}'`
    if (connection) sql([`DELETE FROM contacts WHERE ${ws} AND id IN (SELECT contact_id FROM contact_channels WHERE ${ws} AND channel_id='${q(connection)}')`, `DELETE FROM inbound_events WHERE ${ws} AND channel_id='${q(connection)}'`, `DELETE FROM channels WHERE ${ws} AND id='${q(connection)}'`])
    sql([`DELETE FROM automations WHERE ${ws} AND id='${id}'`, `DELETE FROM sequences WHERE ${ws} AND id='${seq}'`])
  }
})
