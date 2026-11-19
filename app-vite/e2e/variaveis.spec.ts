import { mkdirSync } from "node:fs"
import type { Locator, Page, TestInfo } from "@playwright/test"
import { test, expect } from "./fixtures"
import { ENGINE, WORKSPACE, abrirBotoes, acaoDoTopo, api, canalE2eSql, consulta, escolher, novoTag, q, sql, pastaPrints, textoDoPasso } from "./helpers"
import { subirTelegramFalso, type TelegramFalso } from "./telegram-falso"

const screenshots = pastaPrints("clone-screens")

async function capturar(page: Page, info: TestInfo, tela: string) {
  mkdirSync(screenshots, { recursive: true })
  await page.setViewportSize({ width: info.project.name === "desktop" ? 1440 : 390, height: info.project.name === "desktop" ? 900 : 844 })
  await page.screenshot({ path: `${screenshots}/04-variaveis-${tela}-${info.project.name}.png`, fullPage: false, scale: "css" })
}

async function inserirVariavel(scope: Locator, campo: string, reserva: string) {
  await scope.getByRole("button", { name: "Inserir variável", exact: true }).click()
  const seletor = scope.getByRole("group", { name: "Inserir variável", exact: true })
  await seletor.getByLabel("Campo", { exact: true }).selectOption({ label: campo })
  await seletor.getByRole("textbox", { name: "Texto de reserva", exact: true }).fill(reserva)
  await seletor.getByRole("button", { name: "Inserir no texto", exact: true }).click()
}

function grafo(text: string, connectionId: string) {
  return { nodes: [
    { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} },
    { id: "hello", type: "message", position: { x: 360, y: 0 }, config: { connection_id: connectionId, blocks: [
      { kind: "text", text },
      { kind: "button", id: "abrir", label: "Ver oferta", action: { type: "url", url: "https://exemplo.test/oferta" } },
    ] } },
  ], edges: [{ from: "trigger", port: "next", to: "hello" }] }
}

function preparar(tag: string, connectionId: string, text: string) {
  return [
    `INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('e2e-var-field-${tag}','${WORKSPACE}','Interesse ${tag}','text')`,
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('e2e-var-auto-${tag}','${WORKSPACE}','Boas-vindas ${tag}','${q(JSON.stringify(grafo(text, connectionId)))}')`,
    `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('e2e-var-trigger-${tag}','${WORKSPACE}','e2e-var-auto-${tag}','${connectionId}','Pedido ${tag}','keyword','active','every_time','{"node_id":"trigger"}')`,
    `INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('e2e-var-keyword-${tag}','${WORKSPACE}','e2e-var-trigger-${tag}','is','["variavel-${tag}"]','live',0)`,
  ]
}

function limpar(tag: string, connectionId?: string) {
  const w = `workspace_id='${WORKSPACE}'`
  return [
    ...(connectionId ? [`DELETE FROM contacts WHERE ${w} AND id IN (SELECT contact_id FROM contact_channels WHERE ${w} AND channel_id='${connectionId}')`] : []),
    `DELETE FROM automations WHERE ${w} AND id='e2e-var-auto-${tag}'`,
    `DELETE FROM custom_fields WHERE ${w} AND id='e2e-var-field-${tag}'`,
    `DELETE FROM broadcasts WHERE ${w} AND name='e2e variáveis ${tag}'`,
    ...(connectionId ? [`DELETE FROM channels WHERE ${w} AND id='${connectionId}'`] : []),
  ]
}

test("variáveis: selecionar, persistir, publicar e entregar pelo Telegram falso; campo inexistente bloqueia publicar", { tag: "@celular" }, async ({ page }, info) => {
  const tag = novoTag(), fieldId = `e2e-var-field-${tag}`
  const text = `Olá {{primeiro_nome|cliente}} {{sobrenome|sobrenome}} · {{campo:${fieldId}|sem%20interesse}}`
  let falso: TelegramFalso | undefined
  let connectionId: string | undefined
  try {
    if (info.project.name === "mobile") {
      connectionId = `e2e-var-channel-${tag}`
      sql([...canalE2eSql(connectionId), ...preparar(tag, connectionId, text)])
      await page.goto(`/${WORKSPACE}/automations/e2e-var-auto-${tag}`)
      await expect(page.getByText("Use uma tela maior para editar")).toBeVisible()
      await expect(page.getByRole("list", { name: "Passos da automação" })).toContainText(text)
      await expect(page.getByRole("button", { name: "Publicar", exact: true })).toHaveCount(0)
      await page.reload()
      await expect(page.getByRole("list", { name: "Passos da automação" })).toContainText(text)
      await capturar(page, info, "mensagem")
      return
    }

    const catalogo = await api<{ development?: { providerApiBase: string } }>("/api/connections/catalog")
    // Falha em vez de pular: esta jornada precisa provar entrega no provedor local falso.
    expect(catalogo.development, "Configure DEV_PROVIDER_API_BASE para executar a jornada sem APIs reais.").toBeTruthy()
    const base = new URL(catalogo.development!.providerApiBase)
    expect(["127.0.0.1", "localhost"]).toContain(base.hostname)
    const botId = 9_100_000 + Math.floor(Math.random() * 800_000), token = `${botId}:E2E-variaveis-${tag}`
    falso = await subirTelegramFalso(Number(base.port), { [token]: { id: botId, username: `variaveis_${tag}_bot` } })
    const created = await api<{ connection: { id: string } }>("/api/connections", { method: "POST", body: JSON.stringify({ kind: "telegram", displayName: `Variáveis ${tag}`, credentials: { botToken: token } }) })
    connectionId = created.connection.id
    sql(preparar(tag, connectionId, "Olá "))
    await page.goto(`/${WORKSPACE}/automations/e2e-var-auto-${tag}`)
    const node = page.locator('.react-flow__node[data-id="hello"]')
    await node.click()
    const blocos = page.getByRole("list", { name: "Blocos da mensagem" })
    // Texto e botão seguinte formam um bloco só na tela (o botão salvo vem recolhido como faixa).
    const grupo = blocos.getByRole("listitem").nth(0)
    const texto = grupo.getByRole("group", { name: "Bloco de texto 1", exact: true }), botao = grupo.getByRole("group", { name: /^Botão / })
    await abrirBotoes(page)
    const entrada = texto.getByRole("textbox", { name: "Texto do bloco 1", exact: true })
    await entrada.fill("Olá ")
    await inserirVariavel(texto, "Primeiro nome", "cliente")
    await entrada.pressSequentially(" ")
    await inserirVariavel(texto, "Sobrenome", "sobrenome")
    await entrada.pressSequentially(" · ")
    await inserirVariavel(texto, `Interesse ${tag}`, "sem interesse")
    await expect(entrada).toHaveValue(text)
    await botao.getByRole("textbox", { name: "Título do botão", exact: true }).fill("")
    await inserirVariavel(botao, "Primeiro nome", "cliente")
    await expect(botao.getByRole("textbox", { name: "Título do botão", exact: true })).toHaveValue("{{primeiro_nome|cliente}}")
    await page.getByRole("button", { name: "Salvar rascunho", exact: true }).click()
    await expect(page.getByText("Rascunho salvo", { exact: true })).toBeVisible()
    await page.reload()
    await node.click()
    await expect(entrada).toHaveValue(text)
    await capturar(page, info, "mensagem")
    await page.getByRole("button", { name: "Publicar", exact: true }).click()
    await expect(page.getByText("Publicada · versão 1", { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("button", { name: "Editar", exact: true }).first()).toBeVisible()
    const webhook = falso.webhook()!
    expect(webhook).toBeTruthy()
    const userId = 5_500_000 + Math.floor(Math.random() * 400_000)
    const entregue = await fetch(webhook.url.replace(/^https?:\/\/[^/]+/, ENGINE), {
      method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": webhook.secret_token },
      body: JSON.stringify({ update_id: Date.now(), message: { message_id: 1, from: { id: userId, first_name: "Marina", last_name: "Silva" }, chat: { id: userId, type: "private" }, text: `variavel-${tag}` } }),
    })
    expect(entregue.status).toBe(200)
    await expect.poll(() => falso!.enviadas().filter(m => m.token === token).map(m => m.text), { timeout: 30_000 }).toContain("Olá Marina Silva · sem interesse")
    const enviada = falso.chamadas.find(c => c.token === token && c.metodo === "sendMessage" && c.corpo.text === "Olá Marina Silva · sem interesse")!
    expect(enviada.corpo.reply_markup).toEqual({ inline_keyboard: [[{ text: "Marina", url: "https://exemplo.test/oferta" }]] })

    await page.getByRole("button", { name: "Editar", exact: true }).first().click()
    await node.click()
    await entrada.fill("Olá {{campo:campo-inexistente|cliente}}")
    await page.getByRole("button", { name: "Publicar", exact: true }).click()
    await expect(node.getByRole("img", { name: /^Erro:/ })).toHaveCount(1)
    expect(consulta(`SELECT id FROM automation_versions WHERE workspace_id='${WORKSPACE}' AND automation_id='e2e-var-auto-${tag}'`)).toHaveLength(1)
  } finally {
    await falso?.fechar()
    sql(limpar(tag, connectionId))
  }
})

test("transmissão: seletor insere nome, sobrenome e campo com reserva e mantém o rascunho ao recarregar", { tag: "@celular" }, async ({ page }, info) => {
  const tag = novoTag(), connectionId = `e2e-var-bc-${tag}`, fieldId = `e2e-var-field-${tag}`
  sql([...canalE2eSql(connectionId), `INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('${fieldId}','${WORKSPACE}','Interesse ${tag}','text')`])
  try {
    await page.goto(`/${WORKSPACE}/broadcasts`)
    await acaoDoTopo(page, "Nova transmissão")
    await expect(page).toHaveURL(/\/broadcasts\/new$/)
    const editor = page.locator("main")
    await page.getByRole("textbox", { name: "Nome da transmissão", exact: true }).fill(`e2e variáveis ${tag}`)
    await escolher(page, "Canal conectado", "Canal de teste e2e")
    const entrada = await textoDoPasso(page)
    await entrada.fill("Olá ")
    await inserirVariavel(editor, "Primeiro nome", "cliente")
    await entrada.pressSequentially(" ")
    await inserirVariavel(editor, "Sobrenome", "sobrenome")
    await entrada.pressSequentially(" · ")
    await inserirVariavel(editor, `Interesse ${tag}`, "sem interesse")
    const esperado = `Olá {{primeiro_nome|cliente}} {{sobrenome|sobrenome}} · {{campo:${fieldId}|sem%20interesse}}`
    await expect(entrada).toHaveValue(esperado)
    await acaoDoTopo(page, "Salvar rascunho")
    await expect(page).toHaveURL(/\/broadcasts$/)
    await page.reload()
    await page.getByRole("button", { name: `Editar e2e variáveis ${tag}`, exact: true }).click()
    await expect(page).toHaveURL(/\/broadcasts\/[^/]+$/)
    const salvo = page.locator("main")
    await expect(await textoDoPasso(page)).toHaveValue(esperado)
    expect(consulta<{ status: string; content: string }>(`SELECT status,content FROM broadcasts WHERE workspace_id='${WORKSPACE}' AND name='e2e variáveis ${tag}'`)).toEqual([{ status: "draft", content: esperado }])
    await salvo.getByRole("button", { name: "Inserir variável", exact: true }).click()
    await capturar(page, info, "transmissao")
  } finally {
    sql(limpar(tag, connectionId))
  }
})
