import { test, expect } from "./fixtures"
import { ENGINE, WORKSPACE, api, consulta, novoTag, q, sql, escolherCanalDoPasso, caminhoPrint, escolher, passo } from "./helpers"
import { subirTelegramFalso, type TelegramFalso } from "./telegram-falso"

// Jornada real do painel e motor; o único transporte é o servidor falso em loopback.
test("palavras-chave: duas condições, prévia, criação vinculada e resposta sem acento", { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(120_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>("/api/connections/catalog")
  expect(catalog.development).toBeTruthy()
  expect(new URL(catalog.development!.providerApiBase).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/)
  const tag = novoTag(), bot = 9_000_000 + Math.floor(Math.random() * 999_999)
  const name = `Consulta de preço ${tag}`, reply = `Confira o catálogo ${tag}`
  let fake: TelegramFalso | undefined, connection: string | undefined, id: string | undefined, replacementId: string | undefined, keyword: string | undefined
  const capture = async (screen: string) => {
    await expect(page.getByText(/Carregando métricas/)).toHaveCount(0)
    if (process.env.E2E_CAPTURE_SCREENS === "1") await page.waitForTimeout(700) // termina a animação do painel
    await page.screenshot({ path: process.env.E2E_CAPTURE_SCREENS === "1"
      ? caminhoPrint(`clone-screens/repintura/03-${screen}-${info.project.name}.png`)
      : info.outputPath(`${screen}.png`), scale: "css" })
  }
  try {
    fake = await subirTelegramFalso(Number(new URL(catalog.development!.providerApiBase).port), { [`${bot}:e2e-${tag}`]: { id: bot, username: `e2e_${tag}` } })
    connection = (await api<{ connection: { id: string } }>("/api/connections", { method: "POST", body: JSON.stringify({ kind: "telegram", displayName: `Catálogo local ${tag}`, credentials: { botToken: `${bot}:e2e-${tag}` } }) })).connection.id
    if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/keywords`)
    await page.getByRole("button", { name: "Criar palavra-chave", exact: true }).first().click()
    const panel = page.getByRole("dialog")
    await panel.getByLabel("Nome da palavra-chave").fill(name)
    await escolher(page, "Canal da mensagem", "Telegram", panel)
    await escolher(page, "Conexão da mensagem", `Catálogo local ${tag}`, panel)
    await panel.getByLabel("Nova palavra: Palavras da condição 1").fill(`preco${tag}`)
    await panel.getByLabel("Nova palavra: Palavras da condição 1").press("Enter")
    await expect(panel.getByText("contém estas palavras-chave:", { exact: true })).toBeVisible()
    await expect(panel.getByRole("button", { name: "Remover condição 1" })).toHaveCount(0)
    const add = panel.getByRole("button", { name: "Adicionar condição com “e”", exact: true })
    await add.click()
    await expect(add).toBeDisabled()
    await expect(panel.getByLabel("Condição 3", { exact: true })).toHaveCount(0)
    await escolher(page, "Condição 2", "Não inclui o trecho", panel)
    await panel.getByLabel("Nova palavra: Palavras da condição 2").fill("não")
    await panel.getByLabel("Nova palavra: Palavras da condição 2").press("Enter")
    // Remover uma condição libera outra, mas nunca permite uma terceira.
    await panel.getByRole("button", { name: "Remover condição 2" }).click()
    await expect(add).toBeEnabled()
    await add.click()
    await escolher(page, "Condição 2", "Não inclui o trecho", panel)
    await panel.getByLabel("Nova palavra: Palavras da condição 2").fill("não")
    await panel.getByLabel("Nova palavra: Palavras da condição 2").press("Enter")
    await panel.getByRole("button", { name: "Criar automação", exact: true }).click()
    await expect(page).toHaveURL(/\/automations\/(?!keywords$)[^/]+$/)
    id = page.url().split("/").pop()!
    const rows = await api<{ id: string; name: string; automation_id: string; connection_id: string; active: boolean; rules: unknown[] }[]>("/api/keywords")
    const row = rows.find(r => r.name === name)!
    expect(row).toMatchObject({ automation_id: id, connection_id: connection, active: false, rules: [
      { condition: "contains", words: [`preco${tag}`] }, { condition: "not_contains", words: ["não"] },
    ] })
    keyword = row.id
    await page.reload()
    await expect(page.getByText("Automação não encontrada", { exact: true })).toHaveCount(0)
    if (info.project.name === "mobile") {
      await expect(page.getByRole("heading", { name: `Resposta a ${name}`, exact: true })).toBeVisible()
      await expect(page.getByRole("status").filter({ hasText: "Regra de palavra-chave ligada" })).toContainText(`${name} (pausada)`)
    }
    else await expect(page.getByRole("textbox", { name: "Nome da automação", exact: true })).toHaveValue(`Resposta a ${name}`)
    await capture("editor-vinculado")
    // Construção do grafo no desktop: edição em celular é fora do escopo da spec.
    await page.setViewportSize({ width: 1440, height: 900 })
    await passo(page, "Gatilho").click()
    await expect(page.getByRole("button", { name: `Configurar ${name}`, exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Fechar painel", exact: true }).click()
    await page.getByRole("button", { name: "Adicionar passo", exact: true }).click()
    await page.getByRole("menuitem", { name: "Mensagem", exact: true }).click()
    await escolherCanalDoPasso(page, 'Telegram')
    await page.getByRole("textbox", { name: "Texto do bloco 1", exact: true }).fill(reply)
    await page.getByRole("button", { name: "Salvar rascunho", exact: true }).click()
    await expect(page.getByText("Rascunho salvo", { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Publicar", exact: true }).click()
    await expect(page.getByText("Ao vivo", { exact: true })).toBeVisible()
    if (info.project.name === "mobile") await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/${WORKSPACE}/automations/keywords`)
    await page.getByRole("button", { name: `Mais ações de ${name}`, exact: true }).click()
    await page.getByRole("menuitem", { name: "Editar", exact: true }).click()
    await expect(panel.getByRole("button", { name: "Automação de resposta", exact: true })).toContainText(`Resposta a ${name}`)
    await expect(panel.getByRole("region", { name: "Prévia da automação" })).toContainText(reply)
    await expect(add).toBeDisabled()
    await capture("editar-regra")
    await panel.getByRole("region", { name: "Prévia da automação" }).scrollIntoViewIfNeeded()
    await capture("regra-previa")
    const barra = panel.getByRole("group", { name: "Ações do painel" })
    await expect(barra.getByRole("button", { name: "Salvar palavra-chave", exact: true })).toBeVisible()
    // Publicar a automação pela primeira vez já ligou a regra que nasceu pausada.
    await expect(barra.getByRole("switch", { name: "Regra ativa", exact: true })).toBeChecked()
    await barra.getByRole("button", { name: "Salvar palavra-chave", exact: true }).click()
    await page.reload()
    const item = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) })
    await expect(item).toContainText("Ativa")
    await expect(item.getByRole("list", { name: `Palavras de ${name}, condição 1` }).getByRole("listitem")).toHaveText([`preco${tag}`])
    await expect(item.getByRole("list", { name: `Palavras de ${name}, condição 2` }).getByRole("listitem")).toHaveText(["não"])
    await expect(item.getByText("não contém estas palavras-chave:")).toBeVisible()
    // O interruptor fica no mesmo lugar do cartão: à direita do nome, na mesma linha, também no celular.
    const caixaNome = (await item.getByRole("heading", { name, exact: true }).boundingBox())!
    const caixaSwitch = (await item.getByRole("switch", { name: `Ativar regra ${name}`, exact: true }).boundingBox())!
    expect(caixaSwitch.x).toBeGreaterThan(caixaNome.x + caixaNome.width - 1)
    expect(Math.abs(caixaSwitch.y + caixaSwitch.height / 2 - (caixaNome.y + caixaNome.height / 2))).toBeLessThan(caixaNome.height)
    await capture("lista")
    let serial = Date.now(), delivered = 0
    const deliver = async (text: string) => {
      const hook = fake!.webhook()!, update = ++serial
      expect(new URL(hook.url).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/)
      const res = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret_token },
        body: JSON.stringify({ update_id: update, message: { message_id: update, from: { id: bot + 1, first_name: "Pessoa de teste" }, chat: { id: bot + 1, type: "private" }, text } }) })
      expect(res.status).toBe(200)
      delivered++
      await expect(async () => expect(consulta<{ n: number }>(`SELECT count(*) n FROM inbound_events WHERE channel_id='${q(connection!)}' AND planned_at IS NOT NULL`)[0]?.n).toBe(delivered)).toPass({ timeout: 30_000 })
    }
    await deliver(`Quero PREÇO${tag}`)
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([reply])
    await deliver(`NAO quero PREÇO${tag}`)
    expect(consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs WHERE channel_id='${q(connection)}'`)[0]?.n).toBe(1)
    expect(fake.enviadas().map(m => m.text)).toEqual([reply])
    await item.getByRole("switch", { name: `Ativar regra ${name}`, exact: true }).click()
    await expect(item).toContainText("Pausada")
    await page.reload()
    await expect(item).toContainText("Pausada")
    await deliver(`preço${tag}`)
    expect(consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs WHERE channel_id='${q(connection)}'`)[0]?.n).toBe(1)
    expect(fake.enviadas().map(m => m.text)).toEqual([reply])
    // O mesmo atalho numa regra existente substitui sua resposta sem duplicar a regra.
    await item.getByRole("button", { name: `Mais ações de ${name}`, exact: true }).click()
    await page.getByRole("menuitem", { name: "Editar", exact: true }).click()
    await panel.getByRole("button", { name: "Criar automação", exact: true }).click()
    await expect(page).toHaveURL(/\/automations\/(?!keywords$)[^/]+$/)
    replacementId = page.url().split("/").pop()!
    expect(replacementId).not.toBe(id)
    expect((await api<{ id: string; automation_id: string; active: boolean }[]>("/api/keywords")).find(r => r.id === keyword))
      .toMatchObject({ automation_id: replacementId, active: false })
    await page.goto(`/${WORKSPACE}/automations/keywords`)
    await item.getByRole("button", { name: `Mais ações de ${name}`, exact: true }).click()
    await page.getByRole("menuitem", { name: "Excluir", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Excluir regra", exact: true }).click()
    await expect(item).toHaveCount(0)
    await page.reload()
    expect((await api<{ id: string }[]>("/api/keywords")).some(r => r.id === keyword)).toBe(false)
  } finally {
    await fake?.fechar()
    if (!id || id === "keywords") {
      const own = (await api<{ name: string; automation_id: string }[]>("/api/keywords")).find(row => row.name === name)
      if (own) id = own.automation_id
    }
    const w = `workspace_id='${WORKSPACE}'`
    if (connection) sql([
      `DELETE FROM contacts WHERE ${w} AND id IN (SELECT contact_id FROM contact_channels WHERE ${w} AND channel_id='${q(connection)}')`,
      `DELETE FROM inbound_events WHERE ${w} AND channel_id='${q(connection)}'`,
      `DELETE FROM channels WHERE ${w} AND id='${q(connection)}'`,
    ])
    for (const automation of [id, replacementId]) if (automation) sql([`DELETE FROM automations WHERE ${w} AND id='${q(automation)}'`])
  }
})
