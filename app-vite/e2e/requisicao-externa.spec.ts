import { mkdirSync } from "node:fs"
import type { Locator, Page, TestInfo } from "@playwright/test"
import { test, expect } from "./fixtures"
import { ENGINE, WORKSPACE, api, canalE2eSql, gatilhoDeRascunho, consulta, novoTag, q, sql, escolherCanalDoPasso, pastaPrints, abrirAcao } from "./helpers"
import { subirTelegramFalso, type TelegramFalso } from "./telegram-falso"

const screenshots = pastaPrints("clone-screens")
const ALIAS = "http://provedor-falso.test"

async function capturar(page: Page, info: TestInfo, tela: string, alvo?: Locator) {
  mkdirSync(screenshots, { recursive: true })
  await page.setViewportSize(info.project.name === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 })
  await alvo?.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${screenshots}/24-${tela}-${info.project.name}.png`, scale: "css", animations: "disabled" })
}

const acaoSalva = (nome: string, campo: string) => ({ type: "external_request", method: "GET", url: `${ALIAS}/externo/cliente?nome={primeiro_nome}`,
  headers: [{ name: "X-Teste", value: nome }], mappings: [{ path: "data.plano", field_id: campo }] })

test("requisição externa: configurar, testar com um contato, ver o erro no registro, publicar e gravar o campo", { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(180_000)
  const tag = novoTag(), campo = `e2e-ext-campo-${tag}`, palavra = `externa${tag}`
  const nomeCampo = `Plano externo ${tag}`, sobrenome = `Teste${tag}`
  let automacao = `e2e-ext-auto-${tag}`
  let falso: TelegramFalso | undefined, conexao: string | undefined
  const limpar = () => {
    const w = `workspace_id='${WORKSPACE}'`
    sql([
      ...(conexao ? [`DELETE FROM contacts WHERE ${w} AND id IN (SELECT contact_id FROM contact_channels WHERE ${w} AND channel_id='${q(conexao)}')`, `DELETE FROM inbound_events WHERE ${w} AND channel_id='${q(conexao)}'`] : []),
      `DELETE FROM external_request_logs WHERE ${w} AND automation_id='${automacao}'`, `DELETE FROM automations WHERE ${w} AND id='${automacao}'`, `DELETE FROM custom_fields WHERE ${w} AND id='${campo}'`,
      ...(conexao ? [`DELETE FROM channels WHERE ${w} AND id='${q(conexao)}'`] : []),
    ])
  }
  try {
    if (info.project.name === "mobile") {
      conexao = `e2e-ext-canal-${tag}`
      const grafo = { nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} },
        { id: "acao", type: "action", position: { x: 360, y: 0 }, config: { actions: [acaoSalva(tag, campo)] } }], edges: [{ from: "trigger", port: "next", to: "acao" }] }
      sql([...canalE2eSql(conexao), `INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('${campo}','${WORKSPACE}','${nomeCampo}','text')`,
        `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${automacao}','${WORKSPACE}','Requisição ${tag}','${q(JSON.stringify(grafo))}')`])
      await page.goto(`/${WORKSPACE}/automations/${automacao}`)
      await expect(page.getByRole("list", { name: "Passos da automação" })).toContainText("GET provedor-falso.test/externo/cliente (grava 1 campo)")
      await capturar(page, info, "passos", page.getByRole("list", { name: "Passos da automação" }))
      return
    }

    const catalogo = await api<{ development?: { providerApiBase: string } }>("/api/connections/catalog")
    expect(catalogo.development, "A jornada exige o provedor falso local (DEV_PROVIDER_API_BASE).").toBeTruthy()
    const base = new URL(catalogo.development!.providerApiBase)
    expect(["127.0.0.1", "localhost"]).toContain(base.hostname)
    const botId = 9_300_000 + Math.floor(Math.random() * 600_000), token = `${botId}:E2E-externa-${tag}`
    falso = await subirTelegramFalso(Number(base.port), { [token]: { id: botId, username: `externa_${tag}_bot` } })
    conexao = (await api<{ connection: { id: string } }>("/api/connections", { method: "POST", body: JSON.stringify({ kind: "telegram", displayName: `Externa ${tag}`, credentials: { botToken: token } }) })).connection.id
    sql([`INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('${campo}','${WORKSPACE}','${nomeCampo}','text')`])
    automacao = (await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: `Requisição ${tag}` }) })).id
    // Publicar sem gatilho é barrado: este gatilho nasce desligado só para a publicação passar.
    await gatilhoDeRascunho(automacao, conexao, `externa${tag}`)
    const hook = falso.webhook()!
    const enviar = async (usuario: number, texto: string) => {
      const evento = Date.now() + usuario
      const resposta = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret_token },
        body: JSON.stringify({ update_id: evento, message: { message_id: evento, from: { id: usuario, first_name: "Marina", last_name: sobrenome }, chat: { id: usuario, type: "private" }, text: texto } }) })
      expect(resposta.status).toBe(200)
    }
    const usuario = 5_900_000 + Math.floor(Math.random() * 90_000)
    await enviar(usuario, "oi")
    const contatoQuery = `SELECT c.id FROM contacts c JOIN contact_channels cc ON cc.workspace_id=c.workspace_id AND cc.contact_id=c.id WHERE c.workspace_id='${WORKSPACE}' AND cc.channel_id='${q(conexao)}'`
    await expect(async () => { expect(consulta<{ id: string }>(contatoQuery)).toHaveLength(1) }).toPass({ timeout: 30_000 })
    const contato = consulta<{ id: string }>(contatoQuery)[0].id
    const valorCampo = () => consulta<{ value: string }>(`SELECT value FROM contact_field_values WHERE workspace_id='${WORKSPACE}' AND contact_id='${contato}' AND field_id='${campo}'`)[0]?.value

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${automacao}`)
    await page.getByRole("button", { name: "Adicionar passo", exact: true }).click()
    await page.getByRole("menuitem", { name: "Ações", exact: true }).click()
    await page.getByRole("button", { name: "Adicionar ação", exact: true }).click()
    await page.getByRole("combobox", { name: "Ação 1", exact: true }).click()
    await page.getByRole("option", { name: "Requisição externa", exact: true }).click()
    await page.getByRole("textbox", { name: "Endereço", exact: true }).fill(`${ALIAS}/externo/cliente?nome={primeiro_nome}`)
    await page.getByRole("button", { name: "Adicionar cabeçalho", exact: true }).click()
    await page.getByRole("textbox", { name: "Nome do cabeçalho 1", exact: true }).fill("X-Teste")
    await page.getByRole("textbox", { name: "Valor do cabeçalho 1", exact: true }).fill(tag)
    await page.getByRole("button", { name: "Adicionar mapeamento", exact: true }).click()
    await page.getByRole("textbox", { name: "Caminho no JSON 1", exact: true }).fill("data.plano")
    await page.getByRole("combobox", { name: "Campo de destino 1", exact: true }).click()
    await page.getByRole("option", { name: nomeCampo, exact: true }).click()

    // Testar com um contato: mostra o que seria gravado, não grava, e deixa rastro no registro.
    await page.getByRole("textbox", { name: "Buscar contato", exact: true }).fill(sobrenome)
    await page.getByRole("combobox", { name: "Contato do teste", exact: true }).click()
    await page.getByRole("option", { name: `Marina ${sobrenome}`, exact: true }).click()
    await page.getByRole("button", { name: "Testar requisição", exact: true }).click()
    const resultado = page.getByRole("status", { name: "Resultado do teste", exact: true })
    await expect(resultado).toContainText("Requisição concluída")
    await expect(resultado).toContainText(`gravaria Premium em ${nomeCampo}`)
    await expect(resultado).toContainText("Resposta 200")
    expect(valorCampo()).toBeUndefined()
    await expect.poll(() => falso!.chamadas.filter(c => c.metodo === "externo:GET:cliente").map(c => c.corpo.cabecalho)).toEqual([tag])
    expect(falso.chamadas.find(c => c.metodo === "externo:GET:cliente")!.corpo.url).toBe("/externo/cliente?nome=Marina")
    await capturar(page, info, "painel")

    // Resposta com erro: aparece no teste e no registro, e continua visível depois de recarregar.
    const endereco = page.getByRole("textbox", { name: "Endereço", exact: true })
    await endereco.fill(`${ALIAS}/externo/erro`)
    await page.getByRole("button", { name: "Testar requisição", exact: true }).click()
    await expect(resultado).toContainText("O servidor respondeu 500")
    const registro = page.getByRole("region", { name: "Registro de erros da requisição", exact: true })
    await expect(registro).toContainText("Erro (teste): GET provedor-falso.test/externo/erro")
    await expect(registro).toContainText("HTTP 500")
    await endereco.fill(`${ALIAS}/externo/cliente?nome={primeiro_nome}`)

    // Mensagem depois da ação usa o campo preenchido pela resposta.
    await page.getByRole("button", { name: "Adicionar passo", exact: true }).click()
    await page.getByRole("menuitem", { name: "Mensagem", exact: true }).click()
    await escolherCanalDoPasso(page, 'Telegram')
    await page.getByRole("textbox", { name: "Texto do bloco 1" }).fill(`Seu plano é {{campo:${campo}|nenhum}}`)
    await page.getByRole("button", { name: "Salvar rascunho", exact: true }).click()
    await expect(page.getByText("Rascunho salvo", { exact: true })).toBeVisible()
    await page.reload()
    await page.locator(".react-flow__node-action").click()
    await abrirAcao(page, 1)
    await expect(page.getByRole("combobox", { name: "Ação 1", exact: true })).toContainText("Requisição externa")
    await expect(page.getByRole("textbox", { name: "Endereço", exact: true })).toHaveValue(`${ALIAS}/externo/cliente?nome={primeiro_nome}`)
    await expect(page.getByRole("textbox", { name: "Caminho no JSON 1", exact: true })).toHaveValue("data.plano")
    await expect(page.getByRole("region", { name: "Registro de erros da requisição", exact: true })).toContainText("HTTP 500")
    await page.getByRole("button", { name: "Publicar", exact: true }).click()
    await expect(page.getByText("Ao vivo", { exact: true })).toBeVisible()

    await api("/api/keywords", { method: "POST", body: JSON.stringify({ name: `Externa ${tag}`, channel: "telegram", connection_id: conexao, automation_id: automacao, active: true, rules: [{ condition: "equals", words: [palavra] }] }) })
    await enviar(usuario, palavra)
    await expect.poll(() => falso!.enviadas().map(m => m.text), { timeout: 30_000 }).toContain("Seu plano é Premium")
    expect(valorCampo()).toBe('"Premium"')
    expect(consulta(`SELECT id FROM external_request_logs WHERE workspace_id='${WORKSPACE}' AND automation_id='${automacao}' AND source='run'`)).toHaveLength(0)

    // Falha em execução (500) não derruba o fluxo e entra no registro com a origem "execução".
    await page.getByRole("button", { name: "Editar", exact: true }).first().click()
    await page.locator(".react-flow__node-action").click()
    await abrirAcao(page, 1)
    await page.getByRole("textbox", { name: "Endereço", exact: true }).fill(`${ALIAS}/externo/erro`)
    await page.getByRole("button", { name: "Publicar", exact: true }).click()
    await expect(page.getByText("Ao vivo", { exact: true })).toBeVisible()
    sql([`UPDATE contact_field_values SET value='"Antigo"' WHERE workspace_id='${WORKSPACE}' AND contact_id='${contato}' AND field_id='${campo}'`])
    await enviar(usuario, palavra)
    await expect.poll(() => falso!.enviadas().map(m => m.text).filter(t => t.startsWith("Seu plano")), { timeout: 30_000 }).toEqual(["Seu plano é Premium", "Seu plano é Antigo"])
    expect(valorCampo()).toBe('"Antigo"')
    const erros = consulta<{ error_code: string; status: number }>(`SELECT error_code,status FROM external_request_logs WHERE workspace_id='${WORKSPACE}' AND automation_id='${automacao}' AND source='run'`)
    expect(erros).toEqual([{ error_code: "http_status", status: 500 }])
    await page.reload()
    await page.getByRole("button", { name: "Editar", exact: true }).first().click()
    await page.locator(".react-flow__node-action").click()
    await abrirAcao(page, 1)
    await expect(page.getByRole("region", { name: "Registro de erros da requisição", exact: true })).toContainText("O servidor respondeu 500")
    await capturar(page, info, "registro", page.getByRole("region", { name: "Registro de erros da requisição", exact: true }))

    // Endereço interno nunca publica.
    await page.getByRole("textbox", { name: "Endereço", exact: true }).fill("http://127.0.0.1:8787/admin")
    await page.getByRole("button", { name: "Publicar", exact: true }).click()
    await expect(page.getByRole("alert").filter({ hasText: "internos" })).toBeVisible()
  } finally {
    await falso?.fechar()
    limpar()
  }
})
