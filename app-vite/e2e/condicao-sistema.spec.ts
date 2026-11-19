import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { api, consulta, ENGINE, gatilhoDeRascunho, novoTag, q, sql, WORKSPACE } from './helpers'
import { subirTelegramFalso, type TelegramFalso } from './telegram-falso'

async function escolha(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

type Graph = { nodes: { id: string; type: string; config: { rules?: unknown[] } }[] }

test('condição por idioma: escolher, salvar, reabrir, publicar e seguir pelo ramo certo no Telegram falso', async ({ page }) => {
  test.setTimeout(150_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'Esta jornada exige o transporte falso local.').toBeTruthy()
  const provider = new URL(catalog.development!.providerApiBase)
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(provider.hostname)
  const tag = novoTag(), id = `e2e-sistema-${tag}`, word = `idioma${tag}`
  const sim = `Mensagem em português ${tag}`, nao = `Mensagem para outro idioma ${tag}`
  const bot = 9_000_000 + Math.floor(Math.random() * 999_999)
  let fake: TelegramFalso | undefined, connection: string | undefined
  const graph = { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'cond', type: 'condition', position: { x: 250, y: 0 }, config: { match: 'all', rules: [{ type: 'tag', tag_id: '', operator: 'has' }] } },
    { id: 'yes', type: 'message', position: { x: 500, y: -80 }, config: { blocks: [{ kind: 'text', text: sim }] } },
    { id: 'no', type: 'message', position: { x: 500, y: 80 }, config: { blocks: [{ kind: 'text', text: nao }] } },
  ], edges: [{ from: 'trigger', port: 'next', to: 'cond' }, { from: 'cond', port: 'true', to: 'yes' }, { from: 'cond', port: 'false', to: 'no' }] }
  try {
    fake = await subirTelegramFalso(Number(provider.port), { [`${bot}:e2e-${tag}`]: { id: bot, username: `e2e_${tag}` } })
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', displayName: `e2e Idioma ${tag}`, credentials: { botToken: `${bot}:e2e-${tag}` } }) })).connection.id
    sql([`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','Condição por idioma ${tag}','${q(JSON.stringify(graph))}')`])
    // Publicar sem gatilho é barrado: este gatilho nasce desligado só para a publicação passar.
    await gatilhoDeRascunho(id, connection, `idioma${tag}`)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await page.locator('.react-flow__node[data-id="cond"]').click()
    await escolha(page, 'Regra 1', 'Idioma')
    await expect(page.getByRole('combobox', { name: 'Comparação', exact: true })).toContainText('É igual a')
    await page.getByRole('textbox', { name: 'Valor', exact: true }).fill('pt_BR')
    await expect(page.locator('.react-flow__node[data-id="cond"]')).toContainText('Idioma')
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByText('Rascunho salvo', { exact: true })).toBeVisible()
    const detail = await api<{ automation: { draft_graph: Graph } }>(`/api/automations/${id}`)
    expect(detail.automation.draft_graph.nodes.find(n => n.id === 'cond')?.config.rules).toEqual([{ type: 'system_field', field: 'locale', operator: 'equals', value: 'pt_BR' }])
    await page.reload()
    await page.locator('.react-flow__node[data-id="cond"]').click()
    await expect(page.getByRole('combobox', { name: 'Regra 1', exact: true })).toContainText('Idioma')
    await expect(page.getByRole('textbox', { name: 'Valor', exact: true })).toHaveValue('pt_BR')
    // Teclado: o valor é alcançável e editável sem mouse.
    await page.getByRole('textbox', { name: 'Valor', exact: true }).focus()
    await expect(page.getByRole('textbox', { name: 'Valor', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Ao vivo', { exact: true })).toBeVisible()
    const keyword = await api<{ id: string }>('/api/keywords', { method: 'POST', body: JSON.stringify({ name: `Idioma ${tag}`, channel: 'telegram', automation_id: id, active: true, rules: [{ condition: 'equals', words: [word] }] }) })
    sql([`UPDATE triggers SET channel_id='${q(connection)}' WHERE workspace_id='${WORKSPACE}' AND id=(SELECT trigger_id FROM keywords WHERE workspace_id='${WORKSPACE}' AND id='${q(keyword.id)}')`])
    const hook = fake.webhook()!
    const enviar = async (event: number) => {
      const response = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token }, body: JSON.stringify({ update_id: event, message: { message_id: event, from: { id: bot + 1, first_name: `Idioma${tag}` }, chat: { id: bot + 1, type: 'private' }, text: word } }) })
      expect(response.status).toBe(200)
    }
    // O Telegram não informa idioma: o contato novo cai no ramo "não".
    await enviar(Date.now())
    await expect.poll(() => fake!.enviadas().map(message => message.text), { timeout: 45_000 }).toEqual([nao])
    // Com o idioma definido no contato, a mesma mensagem segue pelo ramo "sim".
    sql([`UPDATE contacts SET locale='pt_BR' WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT contact_id FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND channel_id='${q(connection)}')`])
    await enviar(Date.now() + 1)
    await expect.poll(() => fake!.enviadas().map(message => message.text), { timeout: 45_000 }).toEqual([nao, sim])
    await expect(async () => {
      expect(consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs r JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id WHERE r.workspace_id='${WORKSPACE}' AND v.automation_id='${id}' AND r.status='done'`)[0]?.n).toBe(2)
    }).toPass({ timeout: 30_000 })
    // 390 px: a tela continua utilizável.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    // No celular o editor só mostra o estado: o aviso pede tela maior e o controle de pausa segue disponível.
    await expect(page.getByRole('status').filter({ hasText: 'Use uma tela maior para editar' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pausar automação', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally {
    await fake?.fechar()
    const ws = `workspace_id='${WORKSPACE}'`
    if (connection) sql([`DELETE FROM contacts WHERE ${ws} AND id IN (SELECT contact_id FROM contact_channels WHERE ${ws} AND channel_id='${q(connection)}')`, `DELETE FROM inbound_events WHERE ${ws} AND channel_id='${q(connection)}'`, `DELETE FROM channels WHERE ${ws} AND id='${q(connection)}'`])
    sql([`DELETE FROM automations WHERE ${ws} AND id='${id}'`])
  }
})
