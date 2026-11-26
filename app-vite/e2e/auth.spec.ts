import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { consulta, PAINEL, q, servidorNoAr, sql, pastaPrints } from './helpers'
import { codigoDoEmail, entrarPorCodigo } from './entrar'

// Tela de entrada por código de 6 dígitos (ficha 03 de .scratch/login-por-codigo). Aqui a entrada é PELA TELA; o código
// vem do outbox local pelo mesmo `codigoDoEmail` que o ajudante entrar.ts usa (as outras jornadas entram pela API).
const captures = pastaPrints("clone-screens")
const SESSAO = 'better-auth.session_token'

async function capture(page: Page, name: string, project: string) {
  mkdirSync(captures, { recursive: true })
  await page.screenshot({ path: resolve(captures, `34-${name}-${project}.jpg`), type: 'jpeg', quality: 80 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

const emailDe = (prefixo: string, project: string) => `e2e-auth-${prefixo}-${project}-${Date.now()}@example.test`
const campoCodigo = (page: Page) => page.getByLabel('Código de acesso')
const errado = (codigo: string) => codigo === '000000' ? '111111' : '000000'
const painel = (page: Page) => page.getByRole('navigation', { name: 'Principal' })

/** Pede o código pela etapa 1 da tela e devolve o que chegou ao outbox. */
async function pedirPelaTela(page: Page, email: string): Promise<string> {
  await page.getByLabel('E-mail', { exact: true }).fill(email)
  const desde = Date.now()
  await page.getByRole('button', { name: 'Enviar código', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Digite o código' })).toBeVisible()
  await expect(page.getByText(email, { exact: true })).toBeVisible()
  return codigoDoEmail(email, desde)
}

/** Digita um código no campo (envia sozinho ao completar 6 dígitos) e espera a resposta do motor. */
async function digitar(page: Page, codigo: string) {
  const resposta = page.waitForResponse(r => r.url().includes('/api/auth/sign-in/email-otp'))
  await campoCodigo(page).fill(codigo)
  return resposta
}

/** Erros de página (exceções) da jornada; o console fica de fora: o 400 do código errado aparece lá de propósito. */
function errosDePagina(page: Page) {
  const erros: string[] = []
  page.on('pageerror', error => erros.push(error.message))
  return erros
}

function limpar(emails: string[]) {
  const lista = emails.map(e => `'${q(e)}'`).join(',')
  sql([
    `DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM workspace_members m JOIN user u ON u.id=m.user_id WHERE u.email IN (${lista}) AND m.role='owner')`,
    `DELETE FROM user_api_keys WHERE user_id IN (SELECT id FROM user WHERE email IN (${lista}))`,
    `DELETE FROM user WHERE email IN (${lista})`,
    `DELETE FROM verification WHERE identifier IN (${emails.map(e => `'sign-in-otp-${q(e.toLowerCase())}'`).join(',')})`,
    `DELETE FROM invites WHERE email IN (${lista})`,
    `DELETE FROM email_outbox WHERE recipient IN (${lista})`,
  ])
}

test.beforeEach(async ({ page }, info) => {
  test.skip(!(await servidorNoAr()), 'Suba painel e motor locais para executar a jornada de autenticação.')
  await page.setViewportSize(info.project.name === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 })
})

test('conta existente entra por código pela tela; cookie httpOnly, sessão sobrevive ao recarregar e /login volta ao painel', { tag: "@celular" }, async ({ page, context }, info) => {
  const email = emailDe('existente', info.project.name)
  const erros = errosDePagina(page)
  try {
    // A conta já existe (com espaço próprio) antes de a tela entrar em cena.
    await entrarPorCodigo(context, email, { nome: 'Pessoa de estudo' })
    await page.goto('/')
    await expect(painel(page)).toBeVisible()
    const workspace = new URL(page.url()).pathname.split('/')[1]
    expect(workspace).not.toBe('demo-workspace')
    await context.clearCookies()

    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Acesse seu espaço' })).toBeVisible()
    // Sem Google configurado no local: nem o botão nem o divisor "ou" aparecem.
    await expect(page.getByRole('button', { name: 'Entrar com Google' })).toHaveCount(0)
    await capture(page, 'login', info.project.name)
    const codigo = await pedirPelaTela(page, email)
    await expect(campoCodigo(page)).toBeFocused()
    await expect(page.getByRole('button', { name: /^Reenviar código em \d+ s$/ })).toBeDisabled()
    await capture(page, 'codigo', info.project.name)
    await digitar(page, codigo)
    await expect(painel(page)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/${workspace}/`))
    expect(consulta<{ n: number }>(`SELECT COUNT(*) AS n FROM workspace_members m JOIN user u ON u.id=m.user_id WHERE u.email='${q(email)}'`)[0].n).toBe(1)

    const cookies = await context.cookies()
    expect(cookies.find(cookie => cookie.name.endsWith(SESSAO))?.httpOnly).toBe(true)
    expect(await page.evaluate(() => document.cookie.includes('session_token'))).toBe(false)
    await page.reload()
    await expect(painel(page)).toBeVisible()
    await page.goto('/login')
    await expect(painel(page)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/${workspace}/`))
    expect(erros).toEqual([])
  } finally { limpar([email]) }
})

test('código errado limpa o campo e devolve o foco; 5 erros esgotam o código, nem o certo entra, e o código novo entra', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(90_000)
  const email = emailDe('tentativas', info.project.name)
  const erros = errosDePagina(page)
  try {
    await page.goto('/login')
    const codigo = await pedirPelaTela(page, email)
    expect((await digitar(page, errado(codigo))).status()).toBe(400)
    await expect(page.getByRole('alert')).toContainText('Código incorreto')
    await expect(campoCodigo(page)).toHaveValue('')
    await expect(campoCodigo(page)).toBeFocused()
    await capture(page, 'codigo-errado', info.project.name)
    for (let tentativa = 2; tentativa <= 5; tentativa++) {
      expect((await digitar(page, errado(codigo))).status(), `tentativa ${tentativa}`).toBe(400)
      await expect(page.getByRole('alert')).toContainText('Código incorreto')
      await expect(campoCodigo(page)).toBeFocused()
    }
    // 6ª tentativa, com o código certo: o código esgotou.
    expect((await digitar(page, codigo)).status()).toBe(403)
    await expect(page.getByRole('alert')).toContainText('Muitas tentativas com este código')
    await expect(campoCodigo(page)).toBeDisabled()
    const pedirNovo = page.getByRole('button', { name: 'Pedir código novo', exact: true })
    await expect(pedirNovo).toBeFocused()
    await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeDisabled()
    await capture(page, 'codigo-esgotado', info.project.name)

    const desde = Date.now()
    await pedirNovo.click()
    await expect(page.getByRole('status').filter({ hasText: 'Enviamos um código novo' })).toBeVisible()
    await expect(campoCodigo(page)).toBeEnabled()
    const novo = await codigoDoEmail(email, desde)
    await digitar(page, novo)
    await expect(painel(page)).toBeVisible()
    expect(consulta<{ emailVerified: number }>(`SELECT emailVerified FROM user WHERE email='${q(email)}'`)[0].emailVerified).toBe(1)
    expect(erros).toEqual([])
  } finally { limpar([email]) }
})

test('código vencido avisa e leva a pedir um código novo, que entra', async ({ page }, info) => {
  const email = emailDe('vencido', info.project.name)
  const erros = errosDePagina(page)
  try {
    await page.goto('/login')
    const codigo = await pedirPelaTela(page, email)
    // Envelhece o código no D1 local (a validade é de 10 minutos).
    sql([`UPDATE verification SET expiresAt='${new Date(Date.now() - 60_000).toISOString()}' WHERE identifier='sign-in-otp-${q(email.toLowerCase())}'`])
    expect((await digitar(page, codigo)).status()).toBe(400)
    await expect(page.getByRole('alert')).toContainText('Este código venceu')
    await expect(campoCodigo(page)).toBeDisabled()
    const pedirNovo = page.getByRole('button', { name: 'Pedir código novo', exact: true })
    await expect(pedirNovo).toBeFocused()
    const desde = Date.now()
    await pedirNovo.click()
    await expect(page.getByRole('status').filter({ hasText: 'Enviamos um código novo' })).toBeVisible()
    await digitar(page, await codigoDoEmail(email, desde))
    await expect(painel(page)).toBeVisible()
    expect(erros).toEqual([])
  } finally { limpar([email]) }
})

test('reenvio só depois da contagem (relógio falso), o código anterior deixa de valer, e "Usar outro e-mail" troca sem recarregar', async ({ page }, info) => {
  test.setTimeout(90_000)
  const email = emailDe('reenvio', info.project.name), outro = emailDe('outro', info.project.name)
  const erros = errosDePagina(page)
  try {
    // Relógio falso da página: a contagem de 60 s anda por fastForward, sem esperar o relógio de verdade.
    await page.clock.install()
    await page.goto('/login')
    const primeiro = await pedirPelaTela(page, email)
    // O relógio falso também anda sozinho em tempo real: ler o código no banco leva alguns segundos, então o número
    // exato varia; o que importa é estar contando e desabilitado, e liberar depois de 60 s somados.
    const contando = page.getByRole('button', { name: /^Reenviar código em \d+ s$/ })
    await expect(contando).toBeDisabled()
    await page.clock.fastForward('00:30')
    await expect(contando).toBeDisabled()
    await page.clock.fastForward('00:31')
    const reenviar = page.getByRole('button', { name: 'Reenviar código', exact: true })
    await expect(reenviar).toBeEnabled()
    await expect(page.getByRole('status').filter({ hasText: 'Você já pode pedir outro código.' })).toHaveCount(1)
    const desde = Date.now()
    await reenviar.click()
    await expect(page.getByRole('status').filter({ hasText: 'Enviamos um código novo. O anterior deixou de valer.' })).toBeVisible()
    await expect(contando).toBeDisabled()
    const segundo = await codigoDoEmail(email, desde)
    // Pedir de novo invalida o anterior.
    if (primeiro !== segundo) {
      expect((await digitar(page, primeiro)).status()).toBe(400)
      await expect(page.getByRole('alert')).toContainText('Código incorreto')
    }

    await page.getByRole('button', { name: 'Usar outro e-mail' }).click()
    await expect(page.getByRole('heading', { name: 'Acesse seu espaço' })).toBeVisible()
    await expect(page.getByLabel('E-mail', { exact: true })).toBeFocused()
    await expect(page.getByRole('alert')).toHaveCount(0)
    const codigoOutro = await pedirPelaTela(page, outro)
    await expect(page.getByText(email, { exact: true })).toHaveCount(0)
    await digitar(page, codigoOutro)
    await expect(painel(page)).toBeVisible()
    const entrou = await (await page.request.get('/api/auth/get-session')).json() as { user?: { email?: string } }
    expect(entrou.user?.email).toBe(outro)
    expect(erros).toEqual([])
  } finally { limpar([email, outro]) }
})

test('convite: o login vem com o e-mail do convite, o primeiro código cria a conta e a tela volta sozinha para o convite', { tag: "@celular" }, async ({ page, context, browser }, info) => {
  const email = emailDe('convite', info.project.name), dona = emailDe('dona-convite', info.project.name)
  const erros = errosDePagina(page)
  // Quem convida é uma conta nova, noutro contexto (o limite de convites por hora é por pessoa: a Lia do seed fica de fora).
  const outro = await browser.newContext({ baseURL: PAINEL })
  try {
    await entrarPorCodigo(outro, dona)
    const headers = { origin: PAINEL }
    const espaco = await outro.request.post('/api/workspaces', { headers, data: { name: 'Espaço do convite e2e' } })
    expect(espaco.status(), await espaco.text()).toBe(201)
    const resposta = await outro.request.post('/api/team/invites', { headers: { ...headers, 'x-workspace': (await espaco.json() as { id: string }).id }, data: { email, role: 'viewer' } })
    expect(resposta.status(), await resposta.text()).toBe(201)
    const convite = (await resposta.json() as { url: string }).url
    await semLoginAutomatico(context)
    await page.goto(`/invite${new URL(convite).hash}`)
    await expect(page.getByText(email, { exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'Entrar para continuar' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue(email)
    await expect(page.getByText('Este é o e-mail do seu convite.')).toBeVisible()
    await capture(page, 'convite-entrada', info.project.name)
    expect(consulta(`SELECT id FROM user WHERE email='${q(email)}'`)).toHaveLength(0)
    const desde = Date.now()
    await page.getByRole('button', { name: 'Enviar código', exact: true }).click()
    await digitar(page, await codigoDoEmail(email, desde))
    await expect(page).toHaveURL(/\/invite$/)
    await expect(page.getByRole('button', { name: 'Aceitar convite' })).toBeVisible()
    const conta = consulta<{ emailVerified: number; espacos: number }>(`SELECT u.emailVerified, (SELECT COUNT(*) FROM workspace_members m WHERE m.user_id=u.id) AS espacos FROM user u WHERE u.email='${q(email)}'`)
    // A conta nasceu na entrada, já confirmada, e não ganhou um espaço pessoal no caminho.
    expect(conta).toEqual([{ emailVerified: 1, espacos: 0 }])
    expect(erros).toEqual([])
  } finally { await outro.close(); limpar([email, dona]) }
})

test('conectar um aplicativo sem sessão leva ao login e, depois do código, volta para /conectar com o mesmo pedido', async ({ page, context }, info) => {
  const email = emailDe('conectar', info.project.name)
  const pedido = Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(Date.now() + i * 7) % 16]).join('')
  const erros = errosDePagina(page)
  // O conector (Worker do MCP) não roda nas jornadas: a leitura do pedido e o /callback são respondidos aqui.
  await page.route(`**/pedido/${pedido}`, route => route.fulfill({ json: { cliente: 'Claude', destino: 'claude.ai', local: false }, headers: { 'access-control-allow-origin': '*' } }))
  let devolvido: URLSearchParams | undefined
  await page.route('**/callback', route => { devolvido = new URLSearchParams(route.request().postData() ?? ''); return route.fulfill({ contentType: 'text/html', body: '<title>conector</title><p>ok</p>' }) })
  try {
    await semLoginAutomatico(context)
    await page.goto(`/conectar?pedido=${pedido}`)
    await expect(page).toHaveURL(/\/login$/)
    const codigo = await pedirPelaTela(page, email)
    await digitar(page, codigo)
    await expect(page).toHaveURL(new RegExp(`/conectar\\?pedido=${pedido}$`))
    await expect(page.getByRole('heading', { name: 'Conectar Claude' })).toBeVisible()
    await page.getByRole('button', { name: 'Aprovar' }).click()
    await expect.poll(() => devolvido?.get('pedido')).toBe(pedido)
    expect(devolvido?.get('decisao')).toBe('aprovar')
    expect(consulta<{ n: number }>(`SELECT COUNT(*) AS n FROM user_api_keys k JOIN user u ON u.id=k.user_id WHERE u.email='${q(email)}' AND k.revoked_at IS NULL`)[0].n).toBe(1)
    expect(erros).toEqual([])
  } finally { limpar([email]) }
})

test('rotas antigas de senha, confirmação e link mágico levam ao /login', async ({ page }) => {
  const erros = errosDePagina(page)
  for (const rota of ['/signup', '/verify-email', '/forgot-password', '/reset-password', '/magic-link']) {
    await page.goto(rota)
    await expect(page, rota).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', { name: 'Acesse seu espaço' })).toBeVisible()
  }
  expect(erros).toEqual([])
})

test('"Entrar (teste)" do desenvolvimento entra como a dona do espaço de desenvolvimento, sem senha nem código', async ({ page, context }) => {
  const erros = errosDePagina(page)
  await semLoginAutomatico(context)
  await page.goto('/login')
  const resposta = page.waitForResponse(r => r.url().endsWith('/api/dev/sign-in'))
  await page.getByRole('button', { name: 'Entrar (teste)' }).click()
  expect((await resposta).status()).toBe(200)
  await expect(painel(page)).toBeVisible()
  await expect(page).toHaveURL(/\/demo-workspace\//)
  const sessao = await (await page.request.get('/api/auth/get-session')).json() as { user?: { email?: string } }
  expect(sessao.user?.email).toBe('lia@example.test')
  // A senha está desligada no local: a rota de senha do Better Auth nem existe.
  expect((await page.request.post('/api/auth/sign-in/email', { headers: { origin: PAINEL }, data: { email: 'lia@example.test', password: 'qualquer-coisa-123' } })).status()).toBe(404)
  expect(erros).toEqual([])
})

/**
 * O motor das jornadas roda com o login automático de desenvolvimento, que vale para quem não manda nenhum cookie
 * de sessão. Um cookie de sessão vencido desliga esse atalho, como no publicado: o painel pede a entrada.
 */
async function semLoginAutomatico(context: BrowserContext) {
  await context.addCookies([{ name: SESSAO, value: 'vencida', url: PAINEL }])
}
