import { test, expect } from "./fixtures"
import { WORKSPACE, api, consulta, novoTag, novoGatilho, q, sql } from "./helpers"

// Teste de usabilidade do editor (2026-11-03): gatilhos Hotmart e API, interruptor em rascunho, rótulos dos passos e variável inserida no cursor.
const passoDoGatilho = { position: { x: 40, y: 16 } }

async function novaAutomacao(nome: string, passos: unknown[], edges: unknown[]): Promise<string> {
  const { id } = await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: nome }) })
  await api(`/api/automations/${id}/draft`, { method: "PUT", body: JSON.stringify({ graph: { nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} }, ...passos], edges } }) })
  return id
}
const apagar = (id?: string) => { if (id) sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(id)}'`]) }
const estados = (id: string) => consulta<{ status: string }>(`SELECT status FROM triggers WHERE workspace_id='${WORKSPACE}' AND automation_id='${q(id)}'`)

test("gatilho Hotmart criado aparece no nó, abre o próprio painel e nasce desligado em rascunho", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "O editor é só leitura no celular.")
  const nome = `e2e-hotmart-${novoTag()}`
  let id: string | undefined
  try {
    id = await novaAutomacao(nome, [{ id: "m", type: "message", position: { x: 360, y: 0 }, config: { blocks: [{ kind: "text", text: "Obrigado pela compra" }] } }], [{ from: "trigger", port: "next", to: "m" }])
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await page.locator(".react-flow__node-trigger").click(passoDoGatilho)
    await novoGatilho(page, "Eventos da Hotmart", /compra/i)
    await expect(page.getByRole("combobox", { name: "Conexão" })).toHaveCount(0)
    await page.getByRole("textbox", { name: "Nome do gatilho" }).fill("Compra aprovada")
    await expect(page.getByRole("textbox", { name: /Nova palavra: IDs dos produtos/ })).toHaveAttribute("placeholder", "+ ID do produto")
    await page.getByRole("textbox", { name: /Nova palavra: IDs dos produtos/ }).fill("123")
    await page.getByRole("textbox", { name: /Nova palavra: IDs dos produtos/ }).press("Enter")
    await page.getByRole("button", { name: "Criar gatilho", exact: true }).click()
    const no = page.locator(".react-flow__node-trigger")
    await expect(no).toContainText("Compra na Hotmart")
    await expect(no).toContainText("123")
    // O painel é o do próprio gatilho (não o de palavra-chave) e o interruptor espera a publicação.
    await expect(page.getByRole("heading", { name: "Compra aprovada" })).toBeVisible()
    await expect(page.getByTestId("trigger-type-channel")).toBeVisible()
    await expect(page.getByRole("switch", { name: "Gatilho ativo" })).toBeDisabled()
    await expect(page.getByText("Publique para ativar", { exact: true })).toBeVisible()
    expect(estados(id)).toEqual([{ status: "initial" }])
    await page.reload()
    await expect(page.locator(".react-flow__node-trigger")).toContainText("Compra na Hotmart")
  } finally { apagar(id) }
})

test("palavra digitada sem Enter conta: Criar gatilho habilita e o gatilho nasce com ela", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "O editor é só leitura no celular.")
  const nome = `e2e-sem-enter-${novoTag()}`
  let id: string | undefined
  try {
    id = await novaAutomacao(nome, [{ id: "m", type: "message", position: { x: 360, y: 0 }, config: { blocks: [{ kind: "text", text: "Oi" }] } }], [{ from: "trigger", port: "next", to: "m" }])
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await page.locator(".react-flow__node-trigger").click(passoDoGatilho)
    await novoGatilho(page, "Eventos da Hotmart", /compra/i)
    await page.getByRole("textbox", { name: "Nome do gatilho" }).fill("Compra sem Enter")
    await page.getByRole("textbox", { name: /Nova palavra: IDs dos produtos/ }).fill("teste123")
    const criar = page.getByRole("button", { name: "Criar gatilho", exact: true })
    await expect(criar).toBeEnabled()
    await criar.click()
    await expect(page.locator(".react-flow__node-trigger")).toContainText("teste123")
    expect(estados(id)).toEqual([{ status: "initial" }])
  } finally { apagar(id) }
})

test("entrada externa (API) não pede conexão e o botão diz o que falta", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "O editor é só leitura no celular.")
  const nome = `e2e-api-${novoTag()}`, entrada = `compra_${novoTag().toLowerCase()}`
  let id: string | undefined
  try {
    id = await novaAutomacao(nome, [{ id: "m", type: "message", position: { x: 360, y: 0 }, config: { blocks: [{ kind: "text", text: "Oi" }] } }], [{ from: "trigger", port: "next", to: "m" }])
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await page.locator(".react-flow__node-trigger").click(passoDoGatilho)
    await novoGatilho(page, "Eventos de contato", /sistema externo/i)
    const criar = page.getByRole("button", { name: "Criar gatilho", exact: true })
    await expect(criar).toBeDisabled()
    await expect(page.getByText("Falta dar um nome ao gatilho.", { exact: true })).toBeVisible()
    await expect(page.getByRole("combobox", { name: "Conexão" })).toHaveCount(0)
    await expect(page.getByText(/POST \/api\/public\/v1\/triggers\/fire/).first()).toBeVisible()
    await expect(page.getByText(/reação de coração|palavras e a política/)).toHaveCount(0)
    await page.getByRole("textbox", { name: "Nome do gatilho" }).fill("Compra Aprovada")
    await expect(page.getByText(/só letras minúsculas, números e _/).first()).toBeVisible()
    await expect(criar).toBeDisabled()
    await page.getByRole("textbox", { name: "Nome do gatilho" }).fill(entrada)
    await expect(criar).toBeEnabled()
    await criar.click()
    await expect(page.locator(".react-flow__node-trigger")).toContainText("Entrada externa (API)")
    await expect(page.locator(".react-flow__node-trigger")).toContainText(entrada)
    await expect(page.locator("p", { hasText: /Dispare com/ })).toContainText(entrada)
    expect(estados(id)).toEqual([{ status: "initial" }])
  } finally { apagar(id) }
})

test("rótulos do mapa: ação sem tag, pergunta em e-mail e variável sem a sintaxe crua", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "O editor é só leitura no celular.")
  const nome = `e2e-rotulos-${novoTag()}`
  let id: string | undefined
  try {
    id = await novaAutomacao(nome, [
      { id: "m", type: "message", position: { x: 360, y: 0 }, config: { blocks: [{ kind: "text", text: "Oi {{primeiro_nome|amigo}}, tudo bem? {{email}}" }] } },
      { id: "a", type: "action", position: { x: 720, y: 0 }, config: { actions: [{ type: "add_tag", tag_id: "" }] } },
      { id: "p", type: "question", position: { x: 1080, y: 0 }, config: { text: "Qual é seu e-mail?", answer_type: "email", field_id: "system:email", retry_message: "Tente de novo", max_attempts: 3, skip: false, timeout: { value: 1, unit: "days" }, choices: [], opt_in: [], consent_phrase: "" } },
    ], [{ from: "trigger", port: "next", to: "m" }, { from: "m", port: "next", to: "a" }, { from: "a", port: "next", to: "p" }])
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await expect(page.locator(".react-flow__node-action")).toContainText("Escolha a tag")
    await expect(page.locator(".react-flow__node-action")).not.toContainText("Tag indisponível")
    await expect(page.locator(".react-flow__node-question")).toContainText("Salvar em E-mail")
    await expect(page.locator(".react-flow__node-message")).toContainText("[Primeiro nome ou amigo]")
    await expect(page.locator(".react-flow__node-message")).toContainText("[E-mail]")
    await expect(page.locator(".react-flow__node-message")).not.toContainText("{{")
  } finally { apagar(id) }
})

test("variável entra no cursor com espaço ao redor e sem barra vertical vazia; Coleta de dados avisa que vira Pergunta", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "O editor é só leitura no celular.")
  const nome = `e2e-variavel-${novoTag()}`
  let id: string | undefined
  try {
    id = await novaAutomacao(nome, [{ id: "m", type: "message", position: { x: 360, y: 0 }, config: { channel: "telegram", blocks: [{ kind: "text", text: "Oi, tudo bem?" }] } }], [{ from: "trigger", port: "next", to: "m" }])
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await page.locator(".react-flow__node-message").click({ position: { x: 40, y: 16 } })
    const texto = page.getByRole("textbox", { name: "Texto do bloco 1" })
    await texto.click()
    await texto.press("End")
    await page.getByRole("button", { name: "Inserir variável" }).click()
    await page.getByRole("button", { name: "Inserir no texto" }).click()
    await expect(texto).toHaveValue("Oi, tudo bem? {{primeiro_nome}}")
    // O texto não fica por baixo da barra do bloco (subir, descer, apagar).
    const caixa = await texto.boundingBox()
    const barra = await page.getByRole("button", { name: "Remover bloco 1" }).boundingBox()
    expect(caixa && barra && barra.x >= caixa.x + caixa.width - 2 - 112).toBeTruthy()
    await expect(page.getByText(/Vira um passo Pergunta depois desta mensagem/)).toBeVisible()
    await page.getByRole("button", { name: /Coleta de dados/ }).click()
    await expect(page.locator(".react-flow__node-question")).toHaveCount(1)
    await expect(page.locator(".react-flow__node-question.selected")).toHaveCount(1)
  } finally { apagar(id) }
})
