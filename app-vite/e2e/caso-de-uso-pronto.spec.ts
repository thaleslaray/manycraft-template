import { test, expect } from "./fixtures"
import { ENGINE, WORKSPACE, api, consulta, novoTag, q, sql } from "./helpers"
import { subirTelegramFalso, type TelegramFalso } from "./telegram-falso"

// Jornada: questionário (objetivo) -> caso de uso pronto -> assistente já preenchido -> automação criada -> responde no Telegram falso.
// Sem canal compatível o caso aparece desabilitado com o motivo. O Telegram falso é o único canal da jornada (a lista de conexões é filtrada).
test("caso de uso pronto: do objetivo do questionário até a automação respondendo no Telegram", async ({ page }) => {
  test.setTimeout(150_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>("/api/connections/catalog")
  expect(catalog.development, "Esta jornada precisa do provedor falso local").toBeTruthy()
  const tag = novoTag(), botId = 9_000_000 + Math.floor(Math.random() * 999_999)
  const palavra = `cupom${tag}`, faq = `preco${tag}`, ws = `workspace_id='${WORKSPACE}'`
  const respostaCupom = "Aqui está o seu cupom de desconto! Use na hora de finalizar a compra."
  const antes = consulta<{ profile_answers: string | null }>(`SELECT profile_answers FROM workspaces WHERE id='${WORKSPACE}'`)[0]?.profile_answers ?? null
  const objetivo = (goal: string) => sql([`UPDATE workspaces SET profile_answers='${q(JSON.stringify({ goal }))}' WHERE id='${WORKSPACE}'`])
  const criadas: string[] = []
  let fake: TelegramFalso | undefined, connection = ""
  try {
    fake = await subirTelegramFalso(Number(new URL(catalog.development!.providerApiBase).port), { [`${botId}:e2e-${tag}`]: { id: botId, username: `e2e_${tag}` } })
    connection = (await api<{ connection: { id: string } }>("/api/connections", { method: "POST", body: JSON.stringify({ kind: "telegram", displayName: `e2e Caso ${tag}`, credentials: { botToken: `${botId}:e2e-${tag}` } }) })).connection.id
    // Só o bot falso conta como canal: nenhuma conta de Instagram, então comentário e story ficam bloqueados.
    await page.route("**/api/connections", async route => {
      if (route.request().method() !== "GET") return route.continue()
      // A página pode sair (navegação) entre buscar e ler a resposta: aí a resposta já foi descartada e não há o que filtrar.
      try {
        const resposta = await route.fetch()
        const todas = await resposta.json() as { id: string }[]
        await route.fulfill({ response: resposta, json: todas.filter(c => c.id === connection) })
      } catch (e) {
        if (!/disposed|closed/i.test(String(e))) throw e
      }
    })
    let evento = Date.now()
    async function entregar(texto: string) {
      const hook = fake!.webhook()!, update = ++evento
      const r = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret_token },
        body: JSON.stringify({ update_id: update, message: { message_id: update, from: { id: botId + 1, first_name: `E2e${tag}` }, chat: { id: botId + 1, type: "private" }, text: texto } }) })
      expect(r.status).toBe(200)
    }

    // 1. Vender mais -> cupom por palavra-chave, publicado e respondendo.
    objetivo("sales")
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/dashboard`)
    const sugestao = page.getByRole("region", { name: "Comece aqui" })
    const cupom = sugestao.getByRole("listitem", { name: "Cupom por palavra-chave" })
    await expect(cupom).toBeVisible()
    // Teclado: foco no botão do cartão e Enter abre o assistente.
    // O cartão pode ser remontado quando os dados terminam de chegar; foca de novo até o foco ficar.
    const montar = cupom.getByRole("button")
    await expect(async () => { await montar.focus(); await expect(montar).toBeFocused({ timeout: 500 }) }).toPass()
    await page.keyboard.press("Enter")
    const dialogo = page.getByRole("dialog")
    await expect(dialogo).toContainText("Cupom por palavra-chave · passo 1 de 2")
    // Já preenchido: palavra sugerida e canal único escolhido; só falta a palavra própria.
    await expect(dialogo.getByText("cupom", { exact: true }).first()).toBeVisible()
    await expect(dialogo.getByRole("combobox", { name: "Conexão", exact: true })).toContainText(`e2e Caso ${tag}`)
    const nova = dialogo.getByRole("textbox", { name: /Nova palavra/ })
    await nova.fill(palavra)
    await nova.press("Enter")
    await dialogo.getByRole("button", { name: "Continuar", exact: true }).click()
    await expect(dialogo).toContainText("passo 2 de 2")
    await expect(dialogo.getByLabel("Mensagem enviada")).toHaveValue(respostaCupom)
    await expect(dialogo.getByLabel("Botão (opcional)")).toHaveValue("Ir para a loja")
    // O link do botão é o que falta: sem ele não cria.
    await expect(dialogo.getByRole("button", { name: "Criar e ligar", exact: true })).toBeDisabled()
    await dialogo.getByLabel("Link do botão (obrigatório)").fill("https://loja.example.com/cupom")
    await dialogo.getByRole("radio", { name: "Publicar e ligar agora" }).check()
    await dialogo.getByRole("button", { name: "Criar e ligar", exact: true }).click()
    await expect(page).toHaveURL(/\/automations\/[^/]+$/)
    const idCupom = page.url().split("/").pop()!
    criadas.push(idCupom)
    const detalhe = await api<{ automation: { name: string; status: string } }>(`/api/automations/${idCupom}`)
    expect(detalhe.automation).toMatchObject({ name: "Cupom por palavra-chave", status: "live" })
    await entregar(palavra)
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toContain(respostaCupom)

    // 2. Atender mais rápido -> perguntas frequentes como rascunho: nada responde até publicar.
    objetivo("support")
    await page.goto(`/${WORKSPACE}/dashboard`)
    const perguntas = page.getByRole("listitem", { name: "Respostas às perguntas frequentes" })
    await perguntas.getByRole("button").click()
    await expect(dialogo).toContainText("passo 1 de 2")
    for (const w of ["preço", "horário", "entrega"]) await expect(dialogo.getByText(w, { exact: true }).first()).toBeVisible()
    const campo = dialogo.getByRole("textbox", { name: /Nova palavra/ })
    await campo.fill(faq)
    await campo.press("Enter")
    await dialogo.getByRole("button", { name: "Continuar", exact: true }).click()
    await dialogo.getByLabel("Link do botão (obrigatório)").fill("https://loja.example.com/faq")
    await dialogo.getByRole("radio", { name: "Salvar como rascunho para revisar antes" }).check()
    await dialogo.getByRole("button", { name: "Salvar rascunho", exact: true }).click()
    await expect(page).toHaveURL(/\/automations\/[^/]+$/)
    const idFaq = page.url().split("/").pop()!
    criadas.push(idFaq)
    expect((await api<{ automation: { status: string } }>(`/api/automations/${idFaq}`)).automation.status).toBe("draft")
    const enviadasAntes = fake.enviadas().length
    await entregar(faq)
    await page.waitForTimeout(1500)
    expect(fake.enviadas().length).toBe(enviadasAntes)

    // 3. Engajar seguidores: comentário e story pedem Instagram, aqui bloqueados com o motivo.
    objetivo("engagement")
    for (const largura of [1440, 390]) {
      await page.setViewportSize({ width: largura, height: 844 })
      await page.goto(`/${WORKSPACE}/dashboard`)
      for (const titulo of ["Brinde para quem comenta", "Agradecer quem menciona no story"]) {
        const cartao = page.getByRole("listitem", { name: titulo })
        await expect(cartao).toContainText("Precisa de uma conta do Instagram conectada")
        await expect(cartao.getByRole("button")).toBeDisabled()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    }

    // 4. Celular: o caso por palavra cabe na tela e o assistente completo continua usável.
    objetivo("sales")
    await page.goto(`/${WORKSPACE}/dashboard`)
    await page.getByRole("listitem", { name: "Cupom por palavra-chave" }).getByRole("button").click()
    await expect(page.getByRole("dialog")).toContainText("passo 1 de 2")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  } finally {
    await fake?.fechar()
    sql([`UPDATE workspaces SET profile_answers=${antes === null ? "NULL" : `'${q(antes)}'`} WHERE id='${WORKSPACE}'`])
    for (const id of criadas) sql([`DELETE FROM automations WHERE ${ws} AND id='${q(id)}'`])
    if (connection) sql([
      `DELETE FROM contacts WHERE ${ws} AND id IN (SELECT contact_id FROM contact_channels WHERE ${ws} AND channel_id='${q(connection)}')`,
      `DELETE FROM inbound_events WHERE ${ws} AND channel_id='${q(connection)}'`,
      `DELETE FROM channels WHERE ${ws} AND id='${q(connection)}'`,
    ])
  }
})
