import type { Page, TestInfo } from '@playwright/test'
import { test, expect } from './fixtures'
import { ENGINE, WORKSPACE, api, consulta, novoTag, q, sql, gatilhoDeRascunho, conexaoConectada, escolherCanalDoPasso, caminhoPrint, abrirAcao } from './helpers'
import { subirTelegramFalso, type TelegramFalso } from './telegram-falso'

async function captura(page: Page, info: TestInfo, tela: string) {
  if (process.env.E2E_CAPTURE_SCREENS !== '1') return
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 })
  await page.screenshot({ path: caminhoPrint(`clone-screens/21-${tela}-${info.project.name}.png`), scale: 'css', animations: 'disabled' })
}

async function adicionarAcao(page: Page, nome: string) {
  await page.getByRole('button', { name: 'Adicionar passo', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Ações', exact: true }).click()
  await page.getByRole('button', { name: 'Adicionar ação', exact: true }).click()
  await page.getByRole('combobox', { name: 'Ação 1', exact: true }).click()
  await page.getByRole('option', { name: nome, exact: true }).click()
}

async function adicionarMensagem(page: Page, texto: string) {
  await page.getByRole('button', { name: 'Adicionar passo', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Mensagem', exact: true }).click()
  await escolherCanalDoPasso(page, 'Telegram')
  await page.getByRole('textbox', { name: 'Texto do bloco 1' }).fill(texto)
}

test('ação configurada no editor atribui a conversa no inbox e persiste após recarregar', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(150_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'A jornada exige o transporte falso local.').toBeTruthy()
  const providerBase = new URL(catalog.development!.providerApiBase)
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(providerBase.hostname)
  const tag = novoTag(), bot = 9_000_000 + Math.floor(Math.random() * 999_999), word = `atribuir${tag}`
  const nome = `Atendimento${tag}`, resposta = `Pedido de atendimento recebido ${tag}`
  const members = await api<{ id: string; role: string }[]>('/api/team')
  const member = members.find(item => item.role === 'owner')!
  expect(member, 'O espaço local precisa de um proprietário para atribuir o atendimento.').toBeTruthy()
  const inboxTeam = await api<{ members: { id: string; name: string }[] }>('/api/inbox/context')
  const memberName = inboxTeam.members.find(item => item.id === member.id)!.name
  let fake: TelegramFalso | undefined, connection: string | undefined, automation: string | undefined
  try {
    fake = await subirTelegramFalso(Number(providerBase.port), { [`${bot}:e2e-${tag}`]: { id: bot, username: `e2e_${tag}` } })
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', displayName: `e2e Atendimento ${tag}`, credentials: { botToken: `${bot}:e2e-${tag}` } }) })).connection.id
    automation = (await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: `Atribuir atendimento ${tag}` }) })).id
    // Sem gatilho a publicação é barrada: ele nasce desligado e só liga depois de publicar.
    const trigger = await api<{ id: string }>(`/api/automations/${automation}/triggers`, { method: 'POST', body: JSON.stringify({ name: `Atribuir ${tag}`, connection_id: connection, node_id: 'trigger', words: [word], rule: 'is' }) })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${automation}`)
    await adicionarAcao(page, 'Atribuir conversa')
    await page.getByRole('combobox', { name: 'Pessoa responsável', exact: true }).click()
    await page.getByRole('option').filter({ hasText: member.id.slice(0, 8) }).click()
    await adicionarMensagem(page, resposta)
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByText('Rascunho salvo', { exact: true })).toBeVisible()
    await page.reload()
    await page.locator('.react-flow__node-action').click()
    await abrirAcao(page, 1)
    await expect(page.getByRole('combobox', { name: 'Ação 1', exact: true })).toContainText('Atribuir conversa')
    await expect(page.getByRole('combobox', { name: 'Pessoa responsável', exact: true })).toContainText(member.id.slice(0, 8))
    if (info.project.name === 'desktop') await captura(page, info, 'editor')
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Ao vivo', { exact: true })).toBeVisible()
    await api(`/api/automations/${automation}/triggers/${trigger.id}`, { method: 'PATCH', body: JSON.stringify({ state: 'active' }) })
    const hook = fake.webhook()!, event = Date.now()
    const response = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token }, body: JSON.stringify({ update_id: event, message: { message_id: event, from: { id: bot + 1, first_name: nome }, chat: { id: bot + 1, type: 'private' }, text: word } }) })
    expect(response.status).toBe(200)
    await expect.poll(() => fake!.enviadas().map(message => message.text), { timeout: 30_000 }).toEqual([resposta])
    const conversationQuery = `SELECT c.id,c.assignee_id FROM conversations c JOIN contact_channels cc ON cc.workspace_id=c.workspace_id AND cc.id=c.contact_channel_id WHERE c.workspace_id='${WORKSPACE}' AND cc.channel_id='${q(connection)}'`
    await expect(async () => { expect(consulta<{ assignee_id: string }>(conversationQuery)[0]?.assignee_id).toBe(member.id) }).toPass({ timeout: 30_000 })
    const conversation = consulta<{ id: string }>(conversationQuery)[0]
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.getByRole('list', { name: 'Passos da automação' })).toContainText('Atribu')
      await captura(page, info, 'editor')
    }
    await page.goto(`/${WORKSPACE}/inbox`)
    await page.getByRole('textbox', { name: /Buscar conversa/ }).fill(nome)
    await page.getByRole('button', { name: new RegExp(`${nome}, Telegram`) }).click()
    await expect(page).toHaveURL(new RegExp(`/inbox/${conversation.id}$`))
    // No celular o responsável mora no painel de dados do contato (toque no nome, como nos apps de chat); no computador, no cabeçalho.
    const abrirDados = async () => { if (info.project.name === 'mobile') await page.getByRole('button', { name: /^Ver dados de / }).click() }
    await abrirDados()
    const responsavel = page.getByRole('combobox', { name: 'Responsável pelo atendimento', exact: true })
    await expect(responsavel).toContainText(memberName)
    await expect(page.getByRole('log', { name: 'Histórico da conversa' })).toContainText(word)
    await page.reload()
    await abrirDados()
    await expect(responsavel).toContainText(memberName)
    await captura(page, info, 'inbox')
  } finally {
    await fake?.fechar()
    const ws = `workspace_id='${WORKSPACE}'`
    if (connection) sql([`DELETE FROM contacts WHERE ${ws} AND id IN (SELECT contact_id FROM contact_channels WHERE ${ws} AND channel_id='${q(connection)}')`, `DELETE FROM inbound_events WHERE ${ws} AND channel_id='${q(connection)}'`, `DELETE FROM channels WHERE ${ws} AND id='${q(connection)}'`])
    if (automation) sql([`DELETE FROM automations WHERE ${ws} AND id='${q(automation)}'`])
  }
})

test('publicação com exclusão de contato permite voltar à edição e exige confirmação explícita', { tag: "@celular" }, async ({ page }, info) => {
  const tag = novoTag()
  const automation = (await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: `Exclusão com confirmação ${tag}` }) })).id
  await gatilhoDeRascunho(automation, await conexaoConectada(), `excluir${tag}`)
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${automation}`)
    await adicionarAcao(page, 'Excluir contato')
    await adicionarMensagem(page, `Encerramento ${tag}`)
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Publicar com exclusão de contato', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('contato')
    if (info.project.name === 'desktop') await captura(page, info, 'confirmacao-exclusao')
    await dialog.getByRole('button', { name: 'Voltar à edição', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(consulta<{ published_version_id: string | null }>(`SELECT published_version_id FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(automation)}'`)[0].published_version_id).toBeNull()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Publicar e permitir exclusão', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText('Ao vivo', { exact: true })).toBeVisible()
    expect(consulta<{ published_version_id: string | null }>(`SELECT published_version_id FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(automation)}'`)[0].published_version_id).toBeTruthy()
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.getByRole('list', { name: 'Passos da automação' })).toContainText('Excluir contato')
      await captura(page, info, 'exclusao')
    }
  } finally {
    sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(automation)}'`])
  }
})
