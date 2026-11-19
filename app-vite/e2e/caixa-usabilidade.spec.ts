import { test, expect } from "./fixtures"
import { WORKSPACE, api, canalE2eSql, consulta, contatoSql, limpezaSql, novoTag, sql } from "./helpers"
import { subirTelegramFalso, type TelegramFalso } from "./telegram-falso"

// Achados "quebrado" e "atrapalha" do teste de usabilidade da caixa de entrada (.scratch/usabilidade/caixa.md).

const historico = (page: import("@playwright/test").Page) => page.getByRole("log", { name: "Histórico da conversa" })

test("conversa com mensagem de transmissão abre, com autor Transmissão", async ({ page }) => {
  const t = novoTag(), canal = `e2e-canal-${t}`, conv = `e2e-conv-${t}`, sobrenome = `Difusao${t}`
  sql([...canalE2eSql(canal), ...contatoSql({ id: `e2e-bc-${t}`, canal, nome: "Aline", sobrenome, conversa: { id: conv, mensagens: [{ id: `e2e-bc1-${t}`, texto: `Oi ${t}` }] } }),
    // Como o motor grava: coluna source = broadcast e conteúdo sem o campo sender.
    `INSERT INTO messages(workspace_id,id,conversation_id,direction,source,content,created_at) VALUES ('${WORKSPACE}','e2e-bc2-${t}','${conv}','out','broadcast','${JSON.stringify({ text: `Promoção ${t}`, status: "sent" })}',${Date.now() + 5})`])
  try {
    await page.goto(`/${WORKSPACE}/inbox/${conv}`)
    await expect(historico(page).getByText(`Promoção ${t}`)).toBeVisible()
    await expect(historico(page).getByText("Transmissão")).toBeVisible()
    await expect(page.getByText("Não foi possível abrir o espaço")).toHaveCount(0)
  } finally { sql(limpezaSql()) }
})

test("variáveis da resposta são trocadas ao enviar; emoji fecha com Esc e clique fora; nota não vira prévia; deixar não lida funciona", async ({ page }) => {
  test.setTimeout(120_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>("/api/connections/catalog")
  expect(catalog.development, "A jornada exige o transporte falso local.").toBeTruthy()
  const t = novoTag(), bot = 9_100_000 + Math.floor(Math.random() * 99_999), conv = `e2e-conv-${t}`, sobrenome = `Variavel${t}`
  let fake: TelegramFalso | undefined, connection: string | undefined
  try {
    fake = await subirTelegramFalso(Number(new URL(catalog.development!.providerApiBase).port), { [`${bot}:e2e-${t}`]: { id: bot, username: `e2e_${t}` } })
    connection = (await api<{ connection: { id: string } }>("/api/connections", { method: "POST", body: JSON.stringify({ kind: "telegram", displayName: `e2e Caixa ${t}`, credentials: { botToken: `${bot}:e2e-${t}` } }) })).connection.id
    sql(contatoSql({ id: `e2e-var-${t}`, canal: connection, nome: "Carla", sobrenome, conversa: { id: conv, mensagens: [{ id: `e2e-v1-${t}`, texto: `Preciso de ajuda ${t}` }] } }))
    await page.goto(`/${WORKSPACE}/inbox/${conv}`)
    await expect(historico(page).getByText(`Preciso de ajuda ${t}`)).toBeVisible()

    const maisOpcoes = page.getByRole("button", { name: "Mais opções" })
    if (await maisOpcoes.isVisible()) await maisOpcoes.click()
    // Emoji: Esc fecha; clique fora fecha; os botões seguintes ficam livres.
    const emoji = page.getByRole("button", { name: "Inserir emoji" })
    await emoji.click()
    await expect(page.getByRole("group", { name: "Emojis" })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("group", { name: "Emojis" })).toHaveCount(0)
    await emoji.click()
    await historico(page).click({ position: { x: 4, y: 4 } })
    await expect(page.getByRole("group", { name: "Emojis" })).toHaveCount(0)

    // Variável: botão "Inserir variável" no compositor e troca ao enviar.
    await page.getByRole("button", { name: "Inserir variável" }).click()
    await page.getByRole("button", { name: "Inserir no texto" }).click()
    await expect(page.getByLabel("Sua resposta")).toHaveValue("{{primeiro_nome}}")
    await page.getByLabel("Sua resposta").fill("Olá, {{first_name}}! Aqui é a equipe.")
    await page.getByRole("button", { name: "Enviar pelo Telegram" }).click()
    await expect(historico(page).getByText("Olá, Carla! Aqui é a equipe.")).toBeVisible()
    await expect.poll(() => fake!.enviadas().map(m => m.text)).toContain("Olá, Carla! Aqui é a equipe.")
    expect(fake.enviadas().some(m => m.text.includes("{{"))).toBe(false)

    // Nota interna não vira a prévia da lista.
    await page.getByRole("button", { name: "Nota da equipe" }).click()
    await page.getByLabel("Anotação interna").fill(`Cliente prefere a tarde ${t}`)
    await page.getByRole("button", { name: "Salvar nota" }).click()
    await expect(historico(page).getByText(`Cliente prefere a tarde ${t}`)).toBeVisible()
    await page.goto(`/${WORKSPACE}/inbox`)
    const item = page.getByRole("button", { name: new RegExp(`Carla ${sobrenome}, Telegram`) })
    await page.getByRole("textbox", { name: /Buscar conversa/ }).fill(sobrenome)
    await expect(item).toBeVisible()
    await expect(item).not.toContainText("Cliente prefere a tarde")
    await expect(item).toContainText("Olá, Carla!")

    // Deixar não lida no modo real: volta para a lista e continua não lida.
    await item.click()
    await expect(historico(page).getByText(`Preciso de ajuda ${t}`)).toBeVisible()
    await page.getByRole("button", { name: "Mais ações da conversa" }).click(); await page.getByRole("menuitem", { name: "Deixar não lida" }).click()
    await expect(page).toHaveURL(new RegExp(`/${WORKSPACE}/inbox$`))
    await page.waitForTimeout(1500)
    await expect.poll(() => consulta<{ unread_count: number }>(`SELECT unread_count FROM conversations WHERE id='${conv}'`)[0]?.unread_count).toBe(1)
  } finally {
    sql(limpezaSql())
    if (connection) await api(`/api/connections/${connection}`, { method: "DELETE" }).catch(() => undefined)
    await fake?.fechar()
  }
})

test("Rodar automação lista só o canal da conversa; um formulário por vez e Esc fecha; excluir contato fora da visão principal", async ({ page }) => {
  const t = novoTag(), canal = `e2e-canal-${t}`, canalIg = `e2e-ig-${t}`, conv = `e2e-conv-${t}`, sobrenome = `Canal${t}`
  const automacao = (id: string, nome: string) => [
    `INSERT INTO automations(id,workspace_id,name,status) VALUES ('${id}','${WORKSPACE}','${nome}','live')`,
    `INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('${id}-v','${WORKSPACE}','${id}',1,'{}')`,
    `UPDATE automations SET published_version_id='${id}-v' WHERE id='${id}'`]
  sql([...canalE2eSql(canal), ...canalE2eSql(canalIg, "instagram"), ...contatoSql({ id: `e2e-rod-${t}`, canal, nome: "Rita", sobrenome, conversa: { id: conv, mensagens: [{ id: `e2e-r1-${t}`, texto: `Oi ${t}` }] } }),
    ...automacao(`e2e-auto-tg-${t}`, `Do Telegram ${t}`), ...automacao(`e2e-auto-ig-${t}`, `Do Instagram ${t}`),
    `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status) VALUES ('e2e-trg-tg-${t}','${WORKSPACE}','e2e-auto-tg-${t}','${canal}','Tg','welcome_message','active')`,
    `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status) VALUES ('e2e-trg-ig-${t}','${WORKSPACE}','e2e-auto-ig-${t}','${canalIg}','Ig','welcome_message','active')`])
  try {
    await page.goto(`/${WORKSPACE}/inbox/${conv}`)
    await expect(historico(page).getByText(`Oi ${t}`)).toBeVisible()
    await page.getByRole("button", { name: "Mais ações da conversa" }).click(); await page.getByRole("menuitem", { name: "Rodar automação" }).click()
    const opcoes = page.getByRole("option")
    await expect(opcoes.filter({ hasText: `Do Telegram ${t}` })).toHaveCount(1)
    await expect(opcoes.filter({ hasText: `Do Instagram ${t}` })).toHaveCount(0)

    // Um formulário por vez; Esc fecha o aberto.
    await page.getByRole("button", { name: "Mais ações da conversa" }).click(); await page.getByRole("menuitem", { name: "Lembrete", exact: true }).click()
    await expect(page.getByLabel("Quando")).toBeVisible()
    await expect(page.getByRole("combobox", { name: /Automação publicada/ })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(page.getByLabel("Quando")).toHaveCount(0)
    await page.getByRole("button", { name: "Mais ações da conversa" }).click(); await page.getByRole("menuitem", { name: "Agendar mensagem" }).click()
    await expect(page.getByLabel("Texto da mensagem agendada")).toBeVisible()
    await page.getByRole("button", { name: "Mais ações da conversa" }).click(); await page.getByRole("menuitem", { name: "Rodar automação" }).click()
    await expect(page.getByLabel("Texto da mensagem agendada")).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(page.getByLabel(/Automação publicada/)).toHaveCount(0)

    // Excluir contato fica fora da visão principal: no fim do menu ⋮ e na zona de perigo do painel de dados do contato.
    await expect(page.locator("header").getByRole("button", { name: "Excluir contato" })).toHaveCount(0)
    await page.getByRole("button", { name: "Mais ações da conversa" }).click()
    await expect(page.getByRole("menuitem", { name: "Excluir contato" })).toBeVisible()
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: /^Ver dados de / }).click()
    const zona = page.getByRole("region", { name: "Zona de perigo" })
    await expect(zona.getByRole("button", { name: "Excluir contato" })).toBeVisible()
    await expect(page.locator("header").getByRole("button", { name: "Excluir contato" })).toHaveCount(0)
  } finally {
    sql([`DELETE FROM triggers WHERE id LIKE 'e2e-trg-%-${t}'`, `UPDATE automations SET published_version_id=NULL WHERE id LIKE 'e2e-auto-%-${t}'`,
      `DELETE FROM automation_versions WHERE id LIKE 'e2e-auto-%-${t}-v'`, `DELETE FROM automations WHERE id LIKE 'e2e-auto-%-${t}'`, ...limpezaSql()])
  }
})

test("Nova conversa sem WhatsApp explica o motivo e oferece o caminho", async ({ page }) => {
  // O banco de desenvolvimento pode ter números WhatsApp (demo-whatsapp, sobras de outras jornadas): esta jornada tira o WhatsApp
  // da lista de conexões que o painel recebe, sem mexer no banco, e confere que a lista chegou sem ele.
  let semWhatsapp = false
  await page.route("**/api/connections", async route => {
    if (route.request().method() !== "GET") return route.fallback()
    const resposta = await route.fetch(), lista = await resposta.json() as { kind: string }[]
    semWhatsapp = true
    await route.fulfill({ response: resposta, json: lista.filter(c => c.kind !== "whatsapp") })
  })
  await page.goto(`/${WORKSPACE}/inbox`)
  const novaConversa = page.getByRole("button", { name: "Nova conversa", exact: true }).and(page.locator(":visible")).first()
  const maisAcoes = page.getByRole("button", { name: "Mais ações" })
  await novaConversa.or(maisAcoes).first().waitFor()
  if (await novaConversa.count()) await novaConversa.click()
  else { await page.getByRole("button", { name: "Mais ações" }).click(); await page.getByRole("menuitem", { name: "Nova conversa" }).click() }
  const dialogo = page.getByRole("dialog", { name: "Nova conversa" })
  await expect(dialogo.getByText(/só abrem conversa quando a própria pessoa escreve primeiro/)).toBeVisible()
  await expect(dialogo.getByRole("link", { name: "Contatos" })).toBeVisible()
  await expect(dialogo.getByRole("link", { name: /conecte um número de WhatsApp/ })).toBeVisible()
  expect(semWhatsapp, "o diálogo leu a lista de conexões sem WhatsApp").toBe(true)
})

test("layout: cabeçalho fixo e compositor visível no desktop; celular em tela cheia com compositor à vista", { tag: "@celular" }, async ({ page }, info) => {
  const t = novoTag(), canal = `e2e-canal-${t}`, conv = `e2e-conv-${t}`, sobrenome = `Layout${t}`
  const mensagens = Array.from({ length: 25 }, (_, i) => ({ id: `e2e-l${i}-${t}`, texto: `Mensagem número ${i} ${t}` }))
  sql([...canalE2eSql(canal), ...contatoSql({ id: `e2e-lay-${t}`, canal, nome: "Lia", sobrenome, conversa: { id: conv, mensagens } })])
  try {
    if (info.project.name === "desktop") {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`/${WORKSPACE}/inbox/${conv}`)
      await expect(historico(page).getByText(`Mensagem número 24 ${t}`)).toBeVisible()
      const cabecalho = page.locator("header").filter({ hasText: `Lia ${sobrenome}` })
      const antes = (await cabecalho.boundingBox())!.y
      await page.mouse.wheel(0, 600)
      expect(Math.abs((await cabecalho.boundingBox())!.y - antes)).toBeLessThan(2)
      const campo = (await page.getByLabel("Sua resposta").boundingBox())!
      expect(campo.y + campo.height).toBeLessThanOrEqual(900)
      expect((await historico(page).boundingBox())!.height).toBeGreaterThan(150)
    } else {
      await page.goto(`/${WORKSPACE}/inbox`)
      // Escolher uma pasta fecha o painel de pastas.
      await page.getByText("Pastas de atendimento", { exact: true }).first().click()
      await page.getByRole("button", { name: /^Não atribuído/ }).first().click()
      await expect(page.locator("details").first()).not.toHaveAttribute("open", "")
      await page.goto(`/${WORKSPACE}/inbox/${conv}`)
      await expect(historico(page).getByText(`Mensagem número 24 ${t}`)).toBeVisible()
      await expect(page.getByRole("toolbar", { name: "Filtros das conversas" })).toBeHidden()
      const campo = (await page.getByLabel("Sua resposta").boundingBox())!
      expect(campo.y + campo.height).toBeLessThanOrEqual(844)
    }
  } finally { sql(limpezaSql()) }
})
