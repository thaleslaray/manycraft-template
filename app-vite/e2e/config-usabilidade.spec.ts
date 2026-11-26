import { test, expect } from "./fixtures"
import { subirTelegramFalso, type TelegramFalso } from "./telegram-falso"
import { consulta, novoTag, PAINEL, q, sql, WORKSPACE } from "./helpers"

/**
 * Teste de usabilidade de Configurações e acesso (achados "quebrado" e "atrapalha").
 * Os canais conectam pelo provedor falso de DEV_PROVIDER_API_BASE (Telegram: token 7000001:*, "FORA*" = fora do ar; WhatsApp: token com VALIDO).
 */
const telegramDoFalso = "7000001"

test.describe("Configurações: equipe e convites", () => {
  test("remove um membro com confirmação, copia o link e cancela um convite pendente", async ({ page, context }, info) => {
    test.setTimeout(120_000)
    sql(["DELETE FROM request_limits"]) // convites têm limite de 10 por hora por pessoa
    const tag = novoTag(), email = `e2e-membro-${tag}@example.test`, convidado = `e2e-convite-${tag}@example.test`
    sql([
      `INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES ('e2e-u-${tag}','Membro e2e ${tag}','${q(email)}',1,${Date.now()},${Date.now()})`,
      `INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ('e2e-m-${tag}','${WORKSPACE}','e2e-u-${tag}','editor')`,
    ])
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: PAINEL })
      await page.goto(`/${WORKSPACE}/settings/team`)
      const linha = page.getByRole("row").filter({ hasText: email })
      await expect(linha).toBeVisible()
      await linha.getByRole("button", { name: `Editar Membro e2e ${tag}` }).click()
      await linha.getByRole("button", { name: "Remover da equipe" }).click()
      const confirmacao = page.getByRole("dialog", { name: "Remover da equipe?" })
      await expect(confirmacao).toContainText(email)
      await confirmacao.getByRole("button", { name: "Cancelar" }).click()
      expect(consulta(`SELECT id FROM workspace_members WHERE id='e2e-m-${tag}'`)).toHaveLength(1)
      await linha.getByRole("button", { name: "Remover da equipe" }).click()
      await page.getByRole("dialog", { name: "Remover da equipe?" }).getByRole("button", { name: "Remover da equipe" }).click()
      await expect(page.getByText("Membro removido da equipe.")).toBeVisible()
      await expect(page.getByRole("row").filter({ hasText: email })).toHaveCount(0)
      expect(consulta(`SELECT id FROM workspace_members WHERE id='e2e-m-${tag}'`)).toHaveLength(0)
      // O dono não tem "Editar": ninguém o remove.
      await expect(page.getByRole("button", { name: /^Editar Lia|^Editar Desenvolvimento/ })).toHaveCount(0)

      await page.getByRole("button", { name: "Convidar membro" }).click()
      await page.getByLabel("E-mail da pessoa").fill(convidado)
      await page.getByRole("button", { name: "Gerar convite" }).click()
      const primeiro = await page.getByLabel("Link do convite", { exact: true }).inputValue()
      await page.getByRole("button", { name: "Concluir", exact: true }).click()
      const pendente = page.getByRole("listitem").filter({ hasText: convidado })
      await expect(pendente.getByRole("button", { name: /Copiar link/ })).toBeVisible()
      const antes = consulta<{ token_hash: string }>(`SELECT token_hash FROM invites WHERE email='${q(convidado)}'`)[0]!.token_hash
      await pendente.getByRole("button", { name: /Copiar link/ }).click()
      await expect(page.getByText(/Link copiado/)).toBeVisible()
      const copiado = await page.evaluate(() => navigator.clipboard.readText())
      expect(copiado).toMatch(/\/invite#[0-9a-f-]{64,}/)
      expect(copiado).not.toBe(primeiro)
      expect(consulta<{ token_hash: string }>(`SELECT token_hash FROM invites WHERE email='${q(convidado)}'`)[0]!.token_hash).not.toBe(antes)
      await page.screenshot({ path: test.info().outputPath(`equipe-convite-${info.project.name}.png`) })

      await pendente.getByRole("button", { name: /Cancelar convite/ }).click()
      await expect(page.getByText("Convite cancelado.")).toBeVisible()
      await expect(page.getByRole("listitem").filter({ hasText: convidado })).toHaveCount(0)
      expect(consulta(`SELECT id FROM invites WHERE email='${q(convidado)}'`)).toHaveLength(0)
    } finally {
      sql([`DELETE FROM workspace_members WHERE id='e2e-m-${tag}'`, `DELETE FROM "user" WHERE id='e2e-u-${tag}'`, `DELETE FROM invites WHERE email='${q(convidado)}'`])
    }
  })

  test("o link do convite leva à entrada com o e-mail do convite já preenchido", async ({ page, browser }) => {
    sql(["DELETE FROM request_limits"])
    const tag = novoTag(), convidado = `e2e-cadastro-${tag}@example.test`
    try {
      await page.goto(`/${WORKSPACE}/settings/team`)
      await page.getByRole("button", { name: "Convidar membro" }).click()
      await page.getByLabel("E-mail da pessoa").fill(convidado)
      await page.getByRole("button", { name: "Gerar convite" }).click()
      const link = await page.getByLabel("Link do convite", { exact: true }).inputValue()
      const anonimo = await browser.newContext({ baseURL: PAINEL, locale: "pt-BR" })
      const aba = await anonimo.newPage()
      await aba.goto(link)
      await expect(aba.getByText(convidado)).toBeVisible()
      // Entrada só por código: não há mais cadastro à parte; o primeiro código cria a conta (auth.spec.ts entra de fato).
      await aba.getByRole("link", { name: "Entrar para continuar" }).click()
      await expect(aba).toHaveURL(/\/login$/)
      await expect(aba.getByLabel("E-mail")).toHaveValue(convidado)
      await expect(aba.getByText("Este é o e-mail do seu convite.")).toBeVisible()
      await anonimo.close()
    } finally { sql([`DELETE FROM invites WHERE email='${q(convidado)}'`]) }
  })
})

test.describe("Configurações: avisos de validação em português", () => {
  test("campo vazio mostra a mensagem do painel mesmo com o navegador em inglês (Criar grupo e Enviar código)", async ({ browser }) => {
    const ingles = await browser.newContext({ baseURL: PAINEL, locale: "en-US" })
    const aba = await ingles.newPage()
    try {
      await aba.goto(`/${WORKSPACE}/settings/team/groups`)
      await aba.getByRole("button", { name: "Criar grupo" }).click()
      expect(await aba.getByLabel("Novo grupo").evaluate((el: HTMLInputElement) => el.validationMessage)).toBe("Preencha este campo.")
      await aba.getByLabel("Novo grupo").fill("Vendas e2e")
      expect(await aba.getByLabel("Novo grupo").evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(true)
      await aba.goto("/login")
      await aba.getByRole("button", { name: "Enviar código", exact: true }).click()
      expect(await aba.getByLabel("E-mail").evaluate((el: HTMLInputElement) => el.validationMessage)).toBe("Preencha este campo.")
      await aba.getByLabel("E-mail").fill("sem-arroba")
      await aba.getByRole("button", { name: "Enviar código", exact: true }).click()
      expect(await aba.getByLabel("E-mail").evaluate((el: HTMLInputElement) => el.validationMessage)).toMatch(/e-mail válido/)
    } finally { await ingles.close() }
  })
})

test.describe("Configurações: canais pelo provedor falso", () => {
  test("Telegram: token certo conecta, token inválido e provedor fora do ar dizem coisas diferentes", async ({ page, erros }, info) => {
    test.setTimeout(120_000)
    const catalogo = await fetch(`${PAINEL}/api/connections/catalog`, { headers: { "x-workspace": WORKSPACE } }).then(r => r.json()) as { development?: unknown }
    test.skip(!catalogo.development, "O motor precisa de DEV_PROVIDER_API_BASE apontando para o provedor falso.")
    sql([`DELETE FROM channels WHERE workspace_id='${WORKSPACE}' AND (external_id='${telegramDoFalso}' OR external_id LIKE 'archived:%:${telegramDoFalso}')`])
    let falso: TelegramFalso | undefined
    try {
      falso = await subirTelegramFalso(Number(new URL(catalogo.development!.providerApiBase).port), { [`${telegramDoFalso}:token-bom`]: { id: Number(telegramDoFalso), username: "bot_provedor_falso" } })
      await page.goto(`/${WORKSPACE}/settings/channels`)
      await page.getByRole("button", { name: "Conectar canal" }).first().click()
      const dialogo = page.getByRole("dialog", { name: "Conectar canal" })
      await dialogo.getByRole("radio", { name: "Telegram" }).check()
      await dialogo.getByLabel("Token do bot").fill("9:token-recusado")
      await dialogo.getByRole("button", { name: "Conectar" }).click()
      await expect(dialogo.getByText(/não aceitou este token/)).toBeVisible()
      await expect(dialogo.getByText(/fora do ar/)).toHaveCount(0)

      await dialogo.getByLabel("Token do bot").fill("8000001:FORA-do-ar")
      await dialogo.getByRole("button", { name: "Conectar" }).click()
      await expect(dialogo.getByText(/fora do ar/)).toBeVisible()
      await expect(dialogo.getByText(/não aceitou este token/)).toHaveCount(0)
      await page.screenshot({ path: test.info().outputPath(`canal-fora-do-ar-${info.project.name}.png`) })

      await dialogo.getByLabel("Token do bot").fill(`${telegramDoFalso}:token-bom`)
      await dialogo.getByLabel(/Nome na lista/).fill("Bot do provedor falso")
      await dialogo.getByRole("button", { name: "Conectar" }).click()
      await expect(page.getByText("Canal conectado.")).toBeVisible()
      await expect(page.getByRole("listitem").filter({ hasText: "Bot do provedor falso" }).getByText("Conectada", { exact: true })).toBeVisible()
    } finally {
      await falso?.fechar()
      // As recusas 422 do provedor são o que a jornada provoca de propósito.
      erros.splice(0, erros.length, ...erros.filter(e => !/status of 4(00|22)/.test(e)))
      sql([`DELETE FROM channels WHERE workspace_id='${WORKSPACE}' AND (external_id='${telegramDoFalso}' OR external_id LIKE 'archived:%:${telegramDoFalso}')`])
    }
  })

  test("WhatsApp conecta pelo provedor falso e a seção de roteamento tem título em português", async ({ page }) => {
    test.setTimeout(120_000)
    const catalogo = await fetch(`${PAINEL}/api/connections/catalog`, { headers: { "x-workspace": WORKSPACE } }).then(r => r.json()) as { development?: unknown }
    test.skip(!catalogo.development, "O motor precisa de DEV_PROVIDER_API_BASE apontando para o provedor falso.")
    const numero = `55${Date.now().toString().slice(-10)}`
    const limpar = () => sql([`DELETE FROM channels WHERE workspace_id='${WORKSPACE}' AND (external_id='${numero}' OR external_id LIKE 'archived:%:${numero}')`])
    let falso: TelegramFalso | undefined
    try {
      falso = await subirTelegramFalso(Number(new URL(catalogo.development!.providerApiBase).port), {})
      await page.goto(`/${WORKSPACE}/settings/channels/whatsapp`)
      await page.getByRole("button", { name: /^Conectar/ }).first().click()
      const dialogo = page.getByRole("dialog", { name: "Conectar canal" })
      await dialogo.getByRole("radio", { name: "WhatsApp", exact: true }).first().check()
      await dialogo.getByRole("radio", { name: "WhatsApp", exact: true }).last().check().catch(() => undefined)
      await dialogo.getByLabel("Token de acesso").fill("EAA-VALIDO-e2e")
      await dialogo.getByLabel("ID do número de telefone").fill(numero)
      await dialogo.getByLabel("ID da conta do WhatsApp Business (WABA)").fill("123456789")
      await dialogo.getByLabel("Chave secreta do app").fill("segredo-e2e")
      await dialogo.getByRole("button", { name: "Conectar" }).click()
      await expect(page.getByRole("dialog", { name: "Falta um passo no app da Meta" })).toBeVisible({ timeout: 20_000 })
      await page.getByRole("button", { name: "Concluir" }).click()
      // O provedor falso não entrega o primeiro webhook: marca a conexão como ativa para o painel mostrar o roteamento.
      sql([`UPDATE channels SET connection_state='connected', status_detail=NULL WHERE workspace_id='${WORKSPACE}' AND external_id='${numero}'`])
      // O banco pode ter outros números WhatsApp: a região é a desta conexão, pelo nome que ela ganhou.
      const nome = consulta<{ display_name: string }>(`SELECT display_name FROM channels WHERE workspace_id='${WORKSPACE}' AND external_id='${numero}'`)[0]?.display_name
      expect(nome, "a conexão criada pela jornada").toBeTruthy()
      await page.goto(`/${WORKSPACE}/settings/channels/whatsapp`)
      await expect(page.getByRole("region", { name: `Roteamento de conversas de ${nome}`, exact: true })).toBeVisible()
      await expect(page.getByText("Conversation routing", { exact: true })).toHaveCount(0)
    } finally { await falso?.fechar(); limpar() }
  })
})

test.describe("Configurações: e-mail, campos e popups", () => {
  test("endereço novo não confirmado não vira padrão: botão desabilitado com a dica", async ({ page }, info) => {
    const tag = novoTag(), endereco = `e2e-${tag}@empresa-e2e.com.br`
    try {
      await page.goto(`/${WORKSPACE}/settings/email`)
      await page.getByRole("button", { name: "Novo endereço" }).click()
      await page.getByLabel("Endereço de e-mail").fill(endereco)
      await page.getByLabel("Nome do remetente").fill(`Remetente e2e ${tag}`)
      await page.getByRole("button", { name: "Salvar remetente" }).click()
      await expect(page.getByText("Remetente salvo.")).toBeVisible()
      const linha = page.getByText(endereco, { exact: true }).locator("xpath=ancestor::div[contains(@class,'grid')][1]")
      await expect(linha.getByRole("button", { name: "Usar como padrão" })).toBeDisabled()
      await expect(linha.getByText(/Só um endereço confirmado pode ser o padrão/)).toBeVisible()
      await page.screenshot({ path: test.info().outputPath(`email-padrao-${info.project.name}.png`) })
    } finally { sql([`DELETE FROM email_senders WHERE workspace_id='${WORKSPACE}' AND address='${q(endereco)}'`]) }
  })

  test("Trocar credencial fecha com Esc e o campo já vem focado", async ({ page }) => {
    await page.goto(`/${WORKSPACE}/settings/channels/telegram`)
    await page.getByRole("button", { name: "Trocar credencial" }).first().click()
    const dialogo = page.getByRole("dialog", { name: "Trocar credencial" })
    await expect(dialogo.getByLabel(/Token do bot/)).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(dialogo).toHaveCount(0)
  })

  test("Campos: escolher uma pasta rola até a lista e avisa qual pasta está aberta", { tag: "@celular" }, async ({ page }) => {
    const tag = novoTag(), pastas = Array.from({ length: 30 }, (_, i) => `e2e-pasta-${tag}-${String(i).padStart(2, "0")}`)
    sql([
      ...pastas.map((nome, i) => `INSERT INTO settings_folders(id,workspace_id,kind,name,created_at,updated_at) VALUES ('e2e-f-${tag}-${i}','${WORKSPACE}','fields','${nome}',${Date.now()},${Date.now()})`),
      `INSERT INTO custom_fields(id,workspace_id,scope,name,type,folder_id) VALUES ('e2e-cf-${tag}','${WORKSPACE}','contact','e2e campo ${tag}','text','e2e-f-${tag}-29')`,
    ])
    try {
      await page.goto(`/${WORKSPACE}/settings/fields`)
      const ultima = page.getByRole("button", { name: pastas[29]!, exact: true })
      await ultima.scrollIntoViewIfNeeded()
      await page.evaluate(() => window.scrollTo(0, 0))
      await ultima.click()
      await expect(page.getByRole("status").filter({ hasText: `Mostrando só a pasta ${pastas[29]}` })).toBeInViewport()
      await expect(page.getByText(`e2e campo ${tag}`)).toBeInViewport()
      await page.getByRole("button", { name: "Mostrar todas" }).click()
      await expect(page.getByRole("status").filter({ hasText: "Mostrando só a pasta" })).toHaveCount(0)
    } finally {
      sql([`DELETE FROM custom_fields WHERE id='e2e-cf-${tag}'`, `DELETE FROM settings_folders WHERE id LIKE 'e2e-f-${tag}-%'`])
    }
  })
})

test.describe("Acesso: menu da conta", { tag: "@celular" }, () => {
  test("o menu da conta oferece Sair, que encerra a sessão e volta para a entrada", async ({ page }) => {
    await page.goto(`/${WORKSPACE}/settings`)
    await page.getByRole("button", { name: /^Menu da conta/ }).click()
    await expect(page.getByRole("menuitem", { name: "Sair" })).toBeVisible()
    const pedido = page.waitForRequest(r => r.url().endsWith("/api/auth/sign-out"))
    await page.getByRole("menuitem", { name: "Sair" }).click()
    await pedido
    await expect(page).toHaveURL(/\/login/)
  })
})
