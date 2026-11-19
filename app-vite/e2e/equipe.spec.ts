import { test, expect as baseExpect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { consulta, PAINEL, q, servidorNoAr, sql, pastaPrints } from './helpers'
const expect = baseExpect.configure({ timeout: 30_000 }) // máquina compartilhada com outras sessões

function emailLink(email: string, kind: string) {
  const row = consulta<{ text: string }>(`SELECT text FROM email_outbox WHERE recipient='${q(email)}' AND kind='${q(kind)}' ORDER BY created_at DESC LIMIT 1`)[0]
  const url = row?.text.match(/https?:\/\/[^\s]+/)?.[0]
  if (!url) throw new Error('Link de teste não encontrado no outbox local.')
  return url
}

async function login(page: Page, email: string, name: string) {
  const issued = await page.request.post(`${PAINEL}/api/auth/sign-in/magic-link`, {
    headers: { origin: PAINEL }, data: { email, name, callbackURL: `${PAINEL}/` },
  })
  expect(issued.ok()).toBe(true)
  await page.goto(emailLink(email, 'magic'))
  await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible()
}

async function capture(page: Page, screen: string, project: string) {
  const dir = pastaPrints("clone-screens")
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: resolve(dir, `35-${screen}-${project}.png`), scale: 'css' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test('equipe: convida por link, aceita em outro contexto, atribui conversa, transfere e encerra sessões', { tag: "@celular" }, async ({ page, browser }, info) => {
  test.setTimeout(120_000)
  test.skip(!(await servidorNoAr()), 'Suba o painel e o motor locais.')
  const viewport = info.project.name === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 }
  await page.setViewportSize(viewport)
  const tag = `${info.project.name}-${Date.now()}`
  const owner = `e2e-owner-${tag}@example.test`, guest = `e2e-agent-${tag}@example.test`
  const second = await browser.newContext({ baseURL: PAINEL, viewport, locale: 'pt-BR' })
  const agentPage = await second.newPage()
  const errors: string[] = []
  for (const p of [page, agentPage]) p.on('pageerror', error => errors.push(error.message))
  let workspace = ''
  try {
    await login(page, owner, 'Lia Proprietária')
    workspace = new URL(page.url()).pathname.split('/')[1]
    await page.goto(`/${workspace}/settings/team`)
    await expect(page.getByRole('heading', { name: /^Membros da equipe/ })).toBeVisible()
    await expect(page.getByText(owner, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Convidar membro' }).click()
    await page.getByLabel('E-mail da pessoa').fill(guest)
    await page.getByLabel('Papel do convite').selectOption('livechat_agent')
    await page.getByRole('button', { name: 'Gerar convite' }).click()
    const linkField = page.getByLabel('Link do convite', { exact: true })
    await expect(linkField).toBeVisible()
    const invite = await linkField.inputValue()
    await expect(page.getByText('O link vence em 24 horas e só pode ser usado uma vez.')).toBeVisible()
    const stored = consulta<{ created_at: number; expires_at: number }>(`SELECT created_at,expires_at FROM invites WHERE email='${q(guest)}'`)[0]
    expect(stored.expires_at - stored.created_at).toBe(86400_000)
    await page.getByRole('button', { name: 'Concluir', exact: true }).click()
    await page.reload()
    await expect(page.getByText(guest, { exact: true })).toBeVisible()
    await capture(page, 'equipe-convite', info.project.name)

    // Sessão independente: o convite atravessa o login sem criar um espaço pessoal.
    const issuedGuest = await agentPage.request.post(`${PAINEL}/api/auth/sign-up/email`, {
      headers: { origin: PAINEL }, data: { email: guest, name: 'Ana Atendimento', password: 'Senha-de-estudo-segura-2026!', callbackURL: `${PAINEL}/invite` },
    })
    expect(issuedGuest.ok()).toBe(true)
    await agentPage.goto(invite)
    await agentPage.getByRole('link', { name: 'Entrar para continuar' }).click()
    await expect(agentPage).toHaveURL(/\/login$/)
    await agentPage.getByRole('link', { name: 'Entrar por link no e-mail' }).click()
    await expect(agentPage).toHaveURL(/\/magic-link$/)
    await expect(agentPage.getByRole('heading', { name: 'Entre com um link seguro', exact: true })).toBeVisible()
    await agentPage.getByLabel('E-mail', { exact: true }).fill(guest)
    await expect(agentPage.getByLabel('E-mail', { exact: true })).toHaveValue(guest)
    await agentPage.getByRole('button', { name: 'Enviar link de acesso' }).click()
    await expect(agentPage.getByRole('status')).toContainText('Confira sua caixa de entrada')
    await agentPage.goto(emailLink(guest, 'magic'))
    await expect(agentPage.getByRole('button', { name: 'Aceitar convite' })).toBeVisible()
    await capture(agentPage, 'aceitar-convite', info.project.name)
    await agentPage.getByRole('button', { name: 'Aceitar convite' }).click()
    await expect(agentPage).toHaveURL(new RegExp(`/${workspace}/inbox`))
    await expect(agentPage.getByRole('navigation', { name: 'Principal' })).toBeVisible()
    const accepted = consulta<{ id: string }>(`SELECT m.id FROM workspace_members m JOIN user u ON u.id=m.user_id WHERE m.workspace_id='${q(workspace)}' AND u.email='${q(guest)}'`)[0]
    expect(accepted.id).toBeTruthy()
    expect(consulta(`SELECT id FROM invites WHERE email='${q(guest)}'`)).toHaveLength(0)

    await page.reload()
    const member = page.getByRole('row', { name: /Ana Atendimento/ })
    await expect(member).toBeVisible()
    await member.getByRole('button', { name: 'Editar Ana Atendimento' }).click()
    await member.getByRole('switch', { name: 'Assento de Ana Atendimento' }).click()
    await expect(member.getByRole('switch', { name: 'Assento de Ana Atendimento' })).toBeChecked()
    await page.reload()
    await member.getByRole('button', { name: 'Editar Ana Atendimento' }).click()
    await expect(member.getByRole('switch', { name: 'Assento de Ana Atendimento' })).toBeChecked()
    const roleSaved = page.waitForResponse(response => response.url().includes(`/api/team/${accepted.id}`) && response.request().method() === 'PATCH')
    await member.getByRole('combobox', { name: 'Papel de Ana Atendimento' }).click()
    await page.getByRole('option', { name: 'Editor', exact: true }).click()
    expect((await roleSaved).ok()).toBe(true)
    await page.reload()
    await expect(page.getByRole('rowgroup', { name: 'Editor' }).getByRole('row', { name: /Ana Atendimento/ })).toBeVisible()
    await member.getByRole('button', { name: 'Editar Ana Atendimento' }).click()
    await expect(member.getByRole('combobox', { name: 'Papel de Ana Atendimento' })).toHaveText('Editor')
    const channel = `e2e-team-channel-${tag}`, contact = `e2e-team-contact-${tag}`, conversation = `e2e-team-conversation-${tag}`
    sql([
      `INSERT INTO channels(id,workspace_id,type,external_id,status,display_name) VALUES ('${channel}','${q(workspace)}','telegram','${channel}','disconnected','Conexão local de estudo')`,
      `INSERT INTO contacts(id,workspace_id,first_name) VALUES ('${contact}','${q(workspace)}','Clara Equipe')`,
      `INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id) VALUES ('${contact}-cc','${q(workspace)}','${contact}','${channel}','${contact}')`,
      `INSERT INTO conversations(id,workspace_id,contact_channel_id,status,last_message_at) VALUES ('${conversation}','${q(workspace)}','${contact}-cc','open',${Date.now()})`,
    ])
    await page.goto(`/${workspace}/inbox/${conversation}`)
    // No celular o responsável mora no painel de dados do contato (toque no nome, como nos apps de chat); no computador, no cabeçalho.
    const abrirDados = async () => { if (info.project.name === 'mobile') await page.getByRole('button', { name: /^Ver dados de / }).click() }
    await abrirDados()
    await page.getByRole('combobox', { name: 'Responsável pelo atendimento' }).click()
    await page.getByRole('option', { name: 'Ana Atendimento', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Responsável pelo atendimento' })).toContainText('Ana Atendimento')
    await page.reload()
    await abrirDados()
    await expect(page.getByRole('combobox', { name: 'Responsável pelo atendimento' })).toContainText('Ana Atendimento')
    expect(consulta<{ assignee_id: string }>(`SELECT assignee_id FROM conversations WHERE id='${conversation}'`)[0].assignee_id).toBe(accepted.id)
    await capture(page, 'conversa-atribuida', info.project.name)

    await page.goto(`/${workspace}/settings/team`)
    await member.getByRole('button', { name: 'Editar Ana Atendimento' }).click()
    await member.getByRole('button', { name: 'Transferir propriedade' }).click()
    await expect(page.getByRole('button', { name: 'Confirmar transferência' })).toBeDisabled()
    await page.getByLabel('Digite TRANSFERIR').fill('TRANSFERIR')
    await capture(page, 'transferir-propriedade', info.project.name)
    await page.getByRole('button', { name: 'Confirmar transferência' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('rowgroup', { name: 'Administrador' }).getByRole('row', { name: /Lia Proprietária/ })).toBeVisible()
    await expect(page.getByRole('rowgroup', { name: 'Proprietário' }).getByRole('row', { name: /Ana Atendimento/ })).toBeVisible()
    await capture(page, 'equipe', info.project.name)
    await page.getByRole('button', { name: 'Encerrar todas as sessões' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Encerrar sessões', exact: true }).click()
    await expect(page).toHaveURL(/\/login$/)
    expect(await (await page.request.get(`${PAINEL}/api/auth/get-session`)).json()).toBeNull()
    expect(errors).toEqual([])
  } finally {
    await second.close()
    sql([
      ...(workspace ? [`DELETE FROM workspaces WHERE id='${q(workspace)}'`] : []),
      `DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM workspace_members m JOIN user u ON u.id=m.user_id WHERE u.email IN ('${q(owner)}','${q(guest)}') AND role='owner')`,
      `DELETE FROM user WHERE email IN ('${q(owner)}','${q(guest)}')`,
      `DELETE FROM email_outbox WHERE recipient IN ('${q(owner)}','${q(guest)}')`,
    ])
  }
})
