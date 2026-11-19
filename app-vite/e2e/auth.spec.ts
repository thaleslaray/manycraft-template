import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { consulta, q, servidorNoAr, sql, pastaPrints } from './helpers'

const password = 'Senha-de-estudo-segura-2026!'
const nextPassword = 'Nova-senha-de-estudo-2026!'
const captures = pastaPrints("clone-screens")

function emailLink(email: string, kind: string) {
  const rows = consulta<{ text: string }>(`SELECT text FROM email_outbox WHERE recipient='${q(email)}' AND kind='${q(kind)}' ORDER BY created_at DESC LIMIT 1`)
  const link = rows[0]?.text.match(/https?:\/\/[^\s]+/)?.[0]
  if (!link) throw new Error('O e-mail falso não foi capturado.')
  return link
}

async function capture(page: Page, name: string, project: string) {
  mkdirSync(captures, { recursive: true })
  await page.screenshot({ path: resolve(captures, `34-${name}-${project}.jpg`), type: 'jpeg', quality: 80 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test.beforeEach(async ({ page }, info) => {
  test.skip(!(await servidorNoAr()), 'Suba painel e motor locais para executar a jornada de autenticação.')
  await page.setViewportSize(info.project.name === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 })
})

test('cadastro, verificação, entrada, recuperação e link mágico com e-mail falso e sessão real', { tag: "@celular" }, async ({ page, context }, info) => {
  const email = `e2e-auth-${info.project.name}-${Date.now()}@example.test`
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Acesse seu espaço' })).toBeVisible()
    await capture(page, 'login', info.project.name)
    await page.getByRole('link', { name: 'Criar conta' }).click()
    await expect(page.getByRole('heading', { name: 'Crie sua conta' })).toBeVisible()
    await capture(page, 'cadastro', info.project.name)
    await page.getByLabel('Seu nome').fill('Pessoa de estudo')
    await page.getByLabel('E-mail', { exact: true }).fill(email)
    await page.getByLabel('Senha', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Criar conta', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Confira seu e-mail' })).toBeVisible()
    await capture(page, 'verificacao', info.project.name)
    const verification = emailLink(email, 'verification')
    expect(consulta<{ emailVerified: number }>(`SELECT emailVerified FROM user WHERE email='${q(email)}'`)[0].emailVerified).toBe(0)

    await page.getByRole('link', { name: 'Voltar para a entrada' }).click()
    await expect(page.getByRole('heading', { name: 'Acesse seu espaço' })).toBeVisible()
    await page.getByLabel('E-mail', { exact: true }).fill(email)
    await page.getByLabel('Senha', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Confirme seu e-mail')
    await page.goto(verification)
    await expect(page.getByRole('status')).toContainText('E-mail confirmado')
    await page.getByLabel('E-mail', { exact: true }).fill(email)
    await page.getByLabel('Senha', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible()
    const workspace = new URL(page.url()).pathname.split('/')[1]
    expect(workspace).not.toBe('demo-workspace')
    expect(consulta<{ n: number }>(`SELECT COUNT(*) AS n FROM workspace_members m JOIN user u ON u.id=m.user_id WHERE u.email='${q(email)}' AND workspace_id='${q(workspace)}' AND role='owner'`)[0].n).toBe(1)
    const cookies = await context.cookies()
    expect(cookies.find(cookie => cookie.name.endsWith('better-auth.session_token'))?.httpOnly).toBe(true)
    expect(await page.evaluate(() => document.cookie.includes('session_token'))).toBe(false)
    await page.reload()
    await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible()
    await page.goto('/login')
    await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible()
    await context.clearCookies()

    await page.goto('/login')
    await page.getByRole('link', { name: 'Esqueci minha senha' }).click()
    await capture(page, 'recuperacao', info.project.name)
    await page.getByLabel('E-mail', { exact: true }).fill(email)
    await page.getByRole('button', { name: 'Enviar recuperação' }).click()
    await expect(page.getByRole('status')).toContainText('Se houver uma conta')
    await page.goto(emailLink(email, 'reset'))
    await expect(page.getByRole('heading', { name: 'Defina uma nova senha' })).toBeVisible()
    await capture(page, 'nova-senha', info.project.name)
    await page.getByLabel('Nova senha', { exact: true }).fill(nextPassword)
    await page.getByLabel('Repita a nova senha', { exact: true }).fill(nextPassword)
    await page.getByRole('button', { name: 'Salvar nova senha' }).click()
    await expect(page.getByRole('status')).toContainText('Senha atualizada')
    await page.getByLabel('E-mail', { exact: true }).fill(email)
    await page.getByLabel('Senha', { exact: true }).fill(nextPassword)
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/${workspace}/`))
    await context.clearCookies()

    await page.goto('/login')
    await page.getByRole('link', { name: 'Entrar por link no e-mail' }).click()
    await capture(page, 'link-magico', info.project.name)
    await page.getByLabel('E-mail', { exact: true }).fill(email)
    await page.getByRole('button', { name: 'Enviar link de acesso' }).click()
    await expect(page.getByRole('status')).toContainText('Confira sua caixa de entrada')
    const magic = emailLink(email, 'magic')
    await page.goto(magic)
    await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/${workspace}/`))
    await context.clearCookies()
    await page.goto(magic)
    await expect(page.getByRole('alert')).toContainText('Link inválido ou expirado')
    expect(errors).toEqual([])
  } finally {
    sql([
      `DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM workspace_members m JOIN user u ON u.id=m.user_id WHERE u.email='${q(email)}' AND m.role='owner')`,
      `DELETE FROM user WHERE email='${q(email)}'`,
      `DELETE FROM email_outbox WHERE recipient='${q(email)}'`,
    ])
  }
})
