import { test, expect } from "./fixtures"
import { ENGINE, WORKSPACE, novoGatilho, acaoDaAutomacao, api, consulta, novoTag, sql, q, caminhoPrint } from "./helpers"
import { subirTelegramFalso, type TelegramFalso } from "./telegram-falso"

test("nova automação existe no motor e continua no editor ao recarregar", { tag: "@celular" }, async ({ page }, info) => {
  let id: string | undefined
  try {
    await page.goto(`/${WORKSPACE}/automations`)
    await page.getByRole("button", { name: "Nova automação", exact: true }).first().click()
    await page.getByRole("button", { name: "Começar do zero", exact: true }).click()
    await expect(page).toHaveURL(/\/automations\/[^/]+$/)
    id = page.url().split("/").pop()!
    if (info.project.name === "mobile") {
      await expect(page.getByRole("heading", { name: "Nova automação", exact: true })).toBeVisible()
    } else {
      await expect(page.getByRole("textbox", { name: "Nome da automação" })).toHaveValue("Nova automação")
    }
    await page.reload()
    await expect(page.getByText("Automação não encontrada", { exact: true })).toHaveCount(0)
    const detail = await api<{ automation: { name: string; status: string } }>(`/api/automations/${id}`)
    expect(detail.automation).toMatchObject({ name: "Nova automação", status: "draft" })
  } finally {
    if (id) sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(id)}'`])
  }
})

test("criar, renomear, salvar, publicar, responder, pausar e retomar sem publicar o rascunho", { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(120_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>("/api/connections/catalog")
  expect(catalog.development, "Esta jornada precisa do provedor falso local").toBeTruthy()
  const tag = novoTag(), botId = 9_000_000 + Math.floor(Math.random() * 999_999)
  const name = `Oficina ${tag}`, word = `oficina${tag}`, reply = `Confira os horários da oficina ${tag}`
  // Capturas de revisão são atualizadas só quando solicitado; o check não modifica arquivos versionados.
  const screenshotPath = (screen: string) => process.env.E2E_CAPTURE_SCREENS === "1"
    ? caminhoPrint(`clone-screens/01-${screen}-${info.project.name}.png`)
    : info.outputPath(`${screen}.png`)
  let fake: TelegramFalso | undefined, id: string | undefined, connection: string | undefined
  try {
    fake = await subirTelegramFalso(Number(new URL(catalog.development!.providerApiBase).port), { [`${botId}:e2e-${tag}`]: { id: botId, username: `e2e_${tag}` } })
    const result = await api<{ connection: { id: string } }>("/api/connections", { method: "POST", body: JSON.stringify({ kind: "telegram", displayName: `e2e Oficina ${tag}`, credentials: { botToken: `${botId}:e2e-${tag}` } }) })
    connection = result.connection.id
    // Construção no desktop: edição do grafo em celular está fora do escopo da spec.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations`)
    await page.getByRole("button", { name: "Nova automação", exact: true }).first().click()
    await page.getByRole("button", { name: "Começar do zero", exact: true }).click()
    await expect(page.getByRole("textbox", { name: "Nome da automação" })).toHaveValue("Nova automação")
    id = page.url().split("/").pop()!
    await page.getByRole("textbox", { name: "Nome da automação" }).fill(name)
    await page.getByRole("textbox", { name: "Nome da automação" }).press("Enter")
    await expect(page.getByRole("textbox", { name: "Nome da automação" })).toBeEnabled()
    await page.reload()
    await expect(page.getByRole("textbox", { name: "Nome da automação" })).toHaveValue(name)
    await page.getByRole("button", { name: "Adicionar passo" }).click()
    await page.getByRole("menuitem", { name: "Mensagem", exact: true }).click()
    await page.getByRole("dialog", { name: "Por qual canal vai esta mensagem?" }).getByRole("button", { name: "Telegram", exact: true }).click()
    await page.getByRole("textbox", { name: "Texto do bloco 1" }).fill(reply)
    await page.getByRole("button", { name: "Salvar rascunho", exact: true }).click()
    await expect(page.getByText("Rascunho salvo", { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByText("Rascunho", { exact: true })).toBeVisible()
    await expect(page.locator(".react-flow__node-message")).toContainText(reply)
    // Sem gatilho a publicação é barrada com um aviso claro.
    await page.getByRole("button", { name: "Publicar", exact: true }).click()
    await expect(page.getByText("Adicione um gatilho: sem ele nada dispara esta automação.", { exact: true }).first()).toBeVisible()
    await expect(page.getByText("Ao vivo", { exact: true })).toHaveCount(0)
    // O gatilho é criado pelo editor; em rascunho nasce desligado e o interruptor avisa que precisa publicar.
    await expect(page.getByRole("heading", { name: "Gatilho" })).toBeVisible()
    await novoGatilho(page, "Telegram", /envia uma mensagem/)
    await page.getByRole("textbox", { name: "Nome do gatilho" }).fill("Horários da oficina")
    await page.getByRole("combobox", { name: "Conexão" }).click()
    await page.getByRole("option", { name: `e2e Oficina ${tag}` }).click()
    await page.getByRole("textbox", { name: /Nova palavra/ }).fill(word)
    await page.getByRole("textbox", { name: /Nova palavra/ }).press("Enter")
    await page.getByRole("button", { name: "Criar gatilho", exact: true }).click()
    await expect(page.locator(".react-flow__node-trigger")).toContainText(`Quando chega uma mensagem com “${word}”`)
    await expect(page.getByRole("switch", { name: "Gatilho ativo" })).toBeDisabled()
    await expect(page.getByText("Publique para ativar", { exact: true })).toBeVisible()
    expect(consulta<{ status: string }>(`SELECT status FROM triggers WHERE workspace_id='${WORKSPACE}' AND automation_id='${q(id!)}'`)).toEqual([{ status: "initial" }])
    await page.getByRole("button", { name: "Publicar", exact: true }).click()
    await expect(page.getByText("Ao vivo", { exact: true })).toBeVisible()
    // Publicar liga sozinho o gatilho que estava no estado Inicial.
    await expect(page.getByText("Gatilho “Horários da oficina” ligado.", { exact: true })).toBeVisible()
    expect(consulta<{ status: string }>(`SELECT status FROM triggers WHERE workspace_id='${WORKSPACE}' AND automation_id='${q(id!)}'`)).toEqual([{ status: "active" }])
    await page.reload()
    const published = await api<{ automation: { published_version_id: string } }>(`/api/automations/${id}`)
    await page.getByRole("button", { name: "Editar", exact: true }).first().click()
    await page.locator(".react-flow__node-message").click()
    await page.getByRole("textbox", { name: "Texto do bloco 1" }).fill(`Rascunho futuro ${tag}`)
    await page.getByRole("button", { name: "Salvar rascunho", exact: true }).click()
    await expect(page.getByText("Rascunho salvo", { exact: true })).toBeVisible()
    await page.reload()

    let event = Date.now()
    async function deliver() {
      const hook = fake!.webhook()!
      const update = ++event
      const response = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret_token },
        body: JSON.stringify({ update_id: update, message: { message_id: update, from: { id: botId + 1, first_name: `E2e${tag}` }, chat: { id: botId + 1, type: "private" }, text: word } }) })
      expect(response.status).toBe(200)
      // O Wrangler pode falhar numa leitura concorrente à gravação do motor; repete sem esconder o erro final.
      await expect(async () => {
        expect(consulta<{ n: number }>(`SELECT count(*) n FROM inbound_events WHERE channel_id='${q(connection!)}' AND planned_at IS NOT NULL`)[0]?.n)
          .toBeGreaterThanOrEqual(update - eventBase)
      }).toPass({ timeout: 30_000 })
    }
    const eventBase = event
    await deliver()
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([reply])

    // O mesmo ciclo roda nos dois tamanhos; no celular, só os controles de estado.
    if (info.project.name === "mobile") await page.setViewportSize({ width: 390, height: 844 })
    await acaoDaAutomacao(page, "Pausar automação")
    await expect(page.getByText("Parada", { exact: true })).toBeVisible()
    const viewport = page.viewportSize()!
    await page.setViewportSize({ width: viewport.width < 768 ? 1440 : 390, height: viewport.width < 768 ? 900 : 844 })
    await expect(page.getByText("Parada", { exact: true })).toBeVisible()
    await acaoDaAutomacao(page, "Retomar automação", "ver")
    await page.setViewportSize(viewport)
    await page.reload()
    await expect(page.getByText("Parada", { exact: true })).toBeVisible()
    await deliver()
    expect(fake.enviadas().map(m => m.text)).toEqual([reply])
    await page.screenshot({ path: screenshotPath("editor"), scale: "css" })
    await acaoDaAutomacao(page, "Retomar automação")
    await expect(page.getByText("Ao vivo", { exact: true })).toBeVisible()
    await deliver()
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([reply, reply])

    await page.goto(`/${WORKSPACE}/automations`)
    // O cartão mostra a miniatura do fluxo; o resumo do gatilho fica na visualização em lista.
    await page.getByRole("button", { name: "Visualização no formato de lista" }).click()
    await page.getByRole("textbox", { name: "Buscar automação" }).fill(name)
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name, exact: true }) })
    // Com poucas automações (banco novo) a linha já aparece antes de a busca voltar do motor e é trocada logo depois: espera a lista filtrada.
    await expect(page.getByRole("table", { name: "Automações" }).getByRole("row").filter({ has: page.getByRole("link") })).toHaveCount(1)
    await expect(row).toContainText(`Quando chega uma mensagem com “${word}”`)
    const menu = row.getByRole("button", { name: `Mais ações de ${name}`, exact: true })
    await menu.scrollIntoViewIfNeeded()
    await expect(menu).toBeInViewport()
    await menu.click()
    await page.getByRole("menuitem", { name: "Pausar", exact: true }).click()
    await expect(row.getByText("Parada", { exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole("textbox", { name: "Buscar automação" }).fill(name)
    await expect(row.getByText("Parada", { exact: true })).toBeVisible()
    await deliver()
    expect(fake.enviadas().map(m => m.text)).toEqual([reply, reply])
    await page.screenshot({ path: screenshotPath("lista"), scale: "css" })
    await row.getByRole("button", { name: `Mais ações de ${name}`, exact: true }).click()
    await page.getByRole("menuitem", { name: "Retomar", exact: true }).click()
    await expect(row.getByText("Ao vivo", { exact: true })).toBeVisible()
    await deliver()
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([reply, reply, reply])
    const final = await api<{ automation: { published_version_id: string; has_unpublished_changes: boolean } }>(`/api/automations/${id}`)
    expect(final.automation).toMatchObject({ published_version_id: published.automation.published_version_id, has_unpublished_changes: true })
  } finally {
    await fake?.fechar()
    const ws = `workspace_id='${WORKSPACE}'`
    if (connection) sql([
      `DELETE FROM contacts WHERE ${ws} AND id IN (SELECT contact_id FROM contact_channels WHERE ${ws} AND channel_id='${q(connection)}')`,
      `DELETE FROM inbound_events WHERE ${ws} AND channel_id='${q(connection)}'`,
      `DELETE FROM channels WHERE ${ws} AND id='${q(connection)}'`,
    ])
    if (id) sql([`DELETE FROM automations WHERE ${ws} AND id='${q(id)}'`])
  }
})
