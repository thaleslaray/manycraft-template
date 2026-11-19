import { mkdirSync } from "node:fs"
import type { Page, TestInfo } from "@playwright/test"
import { test, expect } from "./fixtures"
import { ENGINE, WORKSPACE, api, canalE2eSql, consulta, contatoSql, novoTag, q, sql, pastaPrints } from "./helpers"
import { subirTelegramFalso, type TelegramFalso } from "./telegram-falso"

const screenshots = pastaPrints("clone-screens")

async function capturar(page: Page, info: TestInfo, tela: string) {
  mkdirSync(screenshots, { recursive: true })
  await page.setViewportSize({ width: info.project.name === "desktop" ? 1440 : 390, height: info.project.name === "desktop" ? 900 : 844 })
  await page.screenshot({ path: `${screenshots}/05-pergunta-${tela}-${info.project.name}.png`, fullPage: false, scale: "css" })
}

function grafo(tag: string, connectionId: string, pronta = false) {
  return { nodes: [
    { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} },
    { id: "question", type: "question", position: { x: 330, y: 0 }, config: {
      connection_id: connectionId, text: pronta ? "Qual é seu e-mail?" : "Como podemos falar com você?",
      answer_type: pronta ? "email" : "text", field_id: `e2e-pergunta-field-${tag}`,
      retry_message: pronta ? "Confira o endereço e tente novamente." : "Tente novamente.",
      max_attempts: 3, skip: true, timeout: { value: 5, unit: "minutes" }, choices: [],
    } },
    { id: "success", type: "message", position: { x: 680, y: -100 }, config: { connection_id: connectionId, blocks: [{ kind: "text", text: `E-mail recebido ${tag}` }] } },
    { id: "no_response", type: "message", position: { x: 680, y: 180 }, config: { connection_id: connectionId, blocks: [{ kind: "text", text: `Sem resposta ${tag}` }] } },
  ], edges: [
    { from: "trigger", port: "next", to: "question" },
    { from: "question", port: "success", to: "success" },
    { from: "question", port: "no_response", to: "no_response" },
  ] }
}

function preparar(tag: string, connectionId: string, pronta = false) {
  const concorrente = { nodes: [
    { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} },
    { id: "message", type: "message", position: { x: 330, y: 0 }, config: { connection_id: connectionId, blocks: [{ kind: "text", text: `Palavra-chave concorrente ${tag}` }] } },
  ], edges: [{ from: "trigger", port: "next", to: "message" }] }
  return [
    `INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('e2e-pergunta-field-${tag}','${WORKSPACE}','E-mail de contato ${tag}','text')`,
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('e2e-pergunta-auto-${tag}','${WORKSPACE}','Capturar e-mail ${tag}','${q(JSON.stringify(grafo(tag, connectionId, pronta)))}')`,
    `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('e2e-pergunta-trigger-${tag}','${WORKSPACE}','e2e-pergunta-auto-${tag}','${connectionId}','Captura ${tag}','keyword','active','every_time','{"node_id":"trigger"}')`,
    `INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('e2e-pergunta-keyword-${tag}','${WORKSPACE}','e2e-pergunta-trigger-${tag}','is','["pergunta-${tag}"]','live',0)`,
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('e2e-pergunta-concorrente-${tag}','${WORKSPACE}','Concorrente ${tag}','${q(JSON.stringify(concorrente))}')`,
    `INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('e2e-pergunta-concorrente-${tag}-v','${WORKSPACE}','e2e-pergunta-concorrente-${tag}',1,'${q(JSON.stringify(concorrente))}')`,
    `UPDATE automations SET status='live',published_version_id='e2e-pergunta-concorrente-${tag}-v',has_unpublished_changes=0 WHERE workspace_id='${WORKSPACE}' AND id='e2e-pergunta-concorrente-${tag}'`,
    `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('e2e-pergunta-concorrente-trigger-${tag}','${WORKSPACE}','e2e-pergunta-concorrente-${tag}','${connectionId}','Concorrente ${tag}','keyword','active','every_time','{"node_id":"trigger"}')`,
    `INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('e2e-pergunta-concorrente-keyword-${tag}','${WORKSPACE}','e2e-pergunta-concorrente-trigger-${tag}','is','["marina.${tag}@exemplo.test"]','live',0)`,
  ]
}

function limpar(tag: string, connectionId?: string) {
  const w = `workspace_id='${WORKSPACE}'`
  return [
    ...(connectionId ? [`DELETE FROM contacts WHERE ${w} AND id IN (SELECT contact_id FROM contact_channels WHERE ${w} AND channel_id='${connectionId}')`] : []),
    `DELETE FROM contacts WHERE ${w} AND id='e2e-pergunta-contato-${tag}'`,
    `DELETE FROM automations WHERE ${w} AND id IN ('e2e-pergunta-auto-${tag}','e2e-pergunta-concorrente-${tag}')`,
    `DELETE FROM custom_fields WHERE ${w} AND id='e2e-pergunta-field-${tag}'`,
    ...(connectionId ? [`DELETE FROM channels WHERE ${w} AND id='${connectionId}'`] : []),
  ]
}

test("pergunta: editar, publicar, tentar e-mail inválido e capturar válido antes de outra palavra-chave", { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(90_000)
  const tag = novoTag(), fieldId = `e2e-pergunta-field-${tag}`, email = `marina.${tag}@exemplo.test`
  let falso: TelegramFalso | undefined
  let connectionId: string | undefined
  try {
    if (info.project.name === "mobile") {
      connectionId = `e2e-pergunta-channel-${tag}`
      const contactId = `e2e-pergunta-contato-${tag}`
      sql([...canalE2eSql(connectionId), ...preparar(tag, connectionId, true),
        ...contatoSql({ id: contactId, canal: connectionId, nome: "Marina", sobrenome: `Pergunta${tag}` }),
        `INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES ('${WORKSPACE}','${contactId}','${fieldId}','${q(JSON.stringify(email))}')`,
      ])
      await page.goto(`/${WORKSPACE}/automations/e2e-pergunta-auto-${tag}`)
      await expect(page.getByText("Use uma tela maior para editar")).toBeVisible()
      await expect(page.getByRole("list", { name: "Passos da automação" })).toContainText("Qual é seu e-mail?")
      await capturar(page, info, "editor")
      await page.goto(`/${WORKSPACE}/contacts?contact=${contactId}`)
      const campoNoPerfil = page.getByRole("dialog").getByRole("button", { name: `Editar E-mail de contato ${tag}: ${email}`, exact: true })
      await expect(campoNoPerfil).toBeVisible()
      await campoNoPerfil.scrollIntoViewIfNeeded()
      await campoNoPerfil.evaluate(el => { for (let parent: Element | null = el; parent; parent = parent.parentElement) parent.scrollLeft = 0 })
      await capturar(page, info, "perfil")
      return
    }

    const catalogo = await api<{ development?: { providerApiBase: string } }>("/api/connections/catalog")
    expect(catalogo.development, "Configure DEV_PROVIDER_API_BASE para provar a jornada sem APIs reais.").toBeTruthy()
    const base = new URL(catalogo.development!.providerApiBase)
    expect(["127.0.0.1", "localhost"]).toContain(base.hostname)
    const botId = 9_100_000 + Math.floor(Math.random() * 800_000), token = `${botId}:E2E-pergunta-${tag}`
    falso = await subirTelegramFalso(Number(base.port), { [token]: { id: botId, username: `pergunta_${tag}_bot` } })
    const created = await api<{ connection: { id: string } }>("/api/connections", { method: "POST", body: JSON.stringify({ kind: "telegram", displayName: `Pergunta ${tag}`, credentials: { botToken: token } }) })
    connectionId = created.connection.id
    sql(preparar(tag, connectionId))
    await page.goto(`/${WORKSPACE}/automations/e2e-pergunta-auto-${tag}`)
    const node = page.locator('.react-flow__node[data-id="question"]')
    await node.click()
    const editor = page.getByRole("region", { name: "Pergunta", exact: true })
    await editor.getByLabel("Texto da pergunta", { exact: true }).fill("Qual é seu e-mail?")
    await editor.getByLabel("Tipo de resposta", { exact: true }).selectOption("email")
    await editor.getByLabel("Salvar resposta no campo", { exact: true }).selectOption(fieldId)
    await editor.getByLabel("Mensagem de nova tentativa", { exact: true }).fill("Confira o endereço e tente novamente.")
    await editor.getByLabel("Limite de tentativas", { exact: true }).fill("3")
    await editor.getByLabel("Tempo limite", { exact: true }).fill("5")
    await editor.getByLabel("Unidade do tempo limite", { exact: true }).selectOption("minutes")
    await editor.getByRole("checkbox", { name: "Permitir pular", exact: true }).check()
    await page.getByRole("button", { name: "Salvar rascunho", exact: true }).click()
    await expect(page.getByText("Rascunho salvo", { exact: true })).toBeVisible()
    await page.reload()
    await node.click()
    await expect(editor.getByLabel("Texto da pergunta", { exact: true })).toHaveValue("Qual é seu e-mail?")
    await expect(editor.getByLabel("Tipo de resposta", { exact: true })).toHaveValue("email")
    await expect(editor.getByLabel("Salvar resposta no campo", { exact: true })).toHaveValue(fieldId)
    await expect(editor.getByLabel("Mensagem de nova tentativa", { exact: true })).toHaveValue("Confira o endereço e tente novamente.")
    await expect(editor.getByLabel("Limite de tentativas", { exact: true })).toHaveValue("3")
    await expect(editor.getByLabel("Tempo limite", { exact: true })).toHaveValue("5")
    await expect(editor.getByRole("checkbox", { name: "Permitir pular", exact: true })).toBeChecked()
    await editor.getByLabel("Texto da pergunta", { exact: true }).scrollIntoViewIfNeeded()
    await capturar(page, info, "editor")
    await editor.getByRole("checkbox", { name: "Permitir pular", exact: true }).scrollIntoViewIfNeeded()
    await capturar(page, info, "opcoes")
    await page.getByRole("button", { name: "Publicar", exact: true }).click()
    await expect(page.getByText("Publicada · versão 1", { exact: true })).toBeVisible()

    const webhook = falso.webhook()!
    expect(webhook).toBeTruthy()
    const userId = 5_500_000 + Math.floor(Math.random() * 400_000)
    const enviar = async (text: string, messageId: number) => {
      const response = await fetch(webhook.url.replace(/^https?:\/\/[^/]+/, ENGINE), {
        method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": webhook.secret_token },
        body: JSON.stringify({ update_id: Date.now() + messageId, message: { message_id: messageId, from: { id: userId, first_name: "Marina", last_name: `Pergunta${tag}` }, chat: { id: userId, type: "private" }, text } }),
      })
      expect(response.status).toBe(200)
    }
    const enviadas = () => falso!.enviadas().filter(m => m.token === token).map(m => m.text)
    await enviar(`pergunta-${tag}`, 1)
    await expect.poll(enviadas, { timeout: 30_000 }).toContain("Qual é seu e-mail?")
    await enviar("endereco-invalido", 2)
    await expect.poll(enviadas, { timeout: 30_000 }).toContain("Confira o endereço e tente novamente.")
    const contactId = consulta<{ contact_id: string }>(`SELECT contact_id FROM contact_channels WHERE workspace_id='${WORKSPACE}' AND channel_id='${connectionId}' AND external_user_id='${userId}'`)[0]?.contact_id
    expect(contactId).toBeTruthy()
    expect(consulta(`SELECT value FROM contact_field_values WHERE workspace_id='${WORKSPACE}' AND contact_id='${contactId}' AND field_id='${fieldId}'`)).toEqual([])
    await enviar(email, 3)
    await expect.poll(enviadas, { timeout: 30_000 }).toContain(`E-mail recebido ${tag}`)
    expect(enviadas()).not.toContain(`Palavra-chave concorrente ${tag}`)
    expect(consulta(`SELECT value FROM contact_field_values WHERE workspace_id='${WORKSPACE}' AND contact_id='${contactId}' AND field_id='${fieldId}'`)).toEqual([{ value: JSON.stringify(email) }])
    await page.goto(`/${WORKSPACE}/contacts?contact=${contactId}`)
    const perfil = page.getByRole("dialog")
    await expect(perfil.getByRole("heading", { name: `Marina Pergunta${tag}`, exact: true })).toBeVisible()
    await expect(perfil.getByRole("button", { name: `Editar E-mail de contato ${tag}: ${email}`, exact: true })).toBeVisible()
    await page.reload()
    await expect(perfil.getByRole("button", { name: `Editar E-mail de contato ${tag}: ${email}`, exact: true })).toBeVisible()
    await capturar(page, info, "perfil")
  } finally {
    await falso?.fechar()
    sql(limpar(tag, connectionId))
  }
})
