import { test, expect } from "./fixtures"
import { WORKSPACE, api, consulta, gatilhoDeRascunho, novoGatilho, novoTag, passo, q, sql } from "./helpers"
import { APP_ID, PAGINA_ID, subirInstagramUnificadoFalso } from "./instagram-unificado-falso"

// Instagram pelo login unificado, parte 1 (ficha 02): conectar pelo painel com token, ID e chave colados, contra uma Graph falsa local.
test.describe("Instagram (login unificado)", () => {
  test("conectar sem passo de provedor: ler o aviso, colar os campos, o webhook assinado sozinho e a conta repetida recusada", async ({ page, erros }) => {
    const catalogo = await api<{ development?: { providerApiBase: string } }>("/api/connections/catalog")
    test.skip(!catalogo.development, "O engine precisa de DEV_PROVIDER_API_BASE (veja engine/.dev.vars.example) para falar com uma Graph API falsa.")
    const t = novoTag(), conta = `17841${Math.floor(Math.random() * 1e9) + 1e9}`
    const falso = await subirInstagramUnificadoFalso(Number(new URL(catalogo.development!.providerApiBase).port), conta, `unificado_${t}`)
    try {
      await page.goto(`/${WORKSPACE}/settings/channels`)
      await page.getByRole("button", { name: "Conectar canal" }).first().click()
      const dialogo = page.getByRole("dialog", { name: "Conectar canal" })
      await dialogo.getByRole("radio", { name: "Instagram" }).check()
      // Um provedor só (o login unificado): não há passo "Provedor" e os campos aparecem direto.
      await expect(dialogo.getByRole("group", { name: "Provedor" })).toHaveCount(0)
      await expect(dialogo.getByText(/API setup with Unified login/)).toBeVisible()
      await expect(dialogo.getByText(/'O token nunca expira'/)).toBeVisible()
      await expect(dialogo.getByLabel("Token de acesso")).toHaveAttribute("type", "password")
      await dialogo.getByLabel("Token de acesso").fill(`EAAG-e2e-${t}`)
      await dialogo.getByLabel("ID da conta do Instagram").fill(conta)
      await dialogo.getByLabel("Chave secreta do app da Meta").fill(`segredo-${t}`)
      // Sem campo de token de verificação: o ManyCraft gera um e assina o webhook do app sozinho.
      await expect(dialogo.getByLabel(/Token de verificação/)).toHaveCount(0)
      await dialogo.getByLabel(/Nome na lista/).fill(`Instagram unificado ${t}`)
      await page.screenshot({ path: test.info().outputPath("instagram-unificado-dialogo.png") })
      await dialogo.getByRole("button", { name: "Conectar" }).click()

      // Webhook assinado na hora: nenhum passo manual, o diálogo fecha e a conexão já sai conectada.
      await expect(page.getByText("Canal conectado.")).toBeVisible()
      await expect(dialogo).toBeHidden()
      await expect(page.getByRole("dialog", { name: "Falta um passo no app da Meta" })).toHaveCount(0)
      const cartao = page.getByRole("listitem").filter({ hasText: `Instagram unificado ${t}` })
      await expect(cartao.getByText("Conectada", { exact: true })).toBeVisible()
      await page.screenshot({ path: test.info().outputPath("instagram-unificado-conectada.png") })
      await expect(cartao.getByText(new RegExp(`conta ${conta}`))).toBeVisible()
      expect(await page.content()).not.toContain(`EAAG-e2e-${t}`)

      expect(consulta<{ provider: string; display_name: string }>(`SELECT provider,display_name FROM channels WHERE workspace_id='${WORKSPACE}' AND external_id='${q(conta)}'`)[0])
        .toEqual({ provider: "instagram_unified", display_name: `Instagram unificado ${t}` })
      expect(falso.chamadas.some(c => c.metodo === "GET" && c.path.startsWith(`/v26.0/${conta}?fields=id,username`) && c.authorization === `Bearer EAAG-e2e-${t}`)).toBe(true)
      expect(falso.chamadas.some(c => c.metodo === "POST" && c.path.startsWith(`/v26.0/${conta}/subscribed_apps`) && c.authorization === `Bearer EAAG-e2e-${t}`)).toBe(true)
      // A Página ligada foi inscrita com o token DELA, e o webhook do app foi assinado com o token do app depois que a Meta conferiu o callback no motor.
      expect(falso.paginas).toEqual([{ authorization: `Bearer ${falso.tokenDaPagina}`, campos: expect.stringContaining("messages") }])
      expect(falso.verificacoes).toEqual([{ callback: expect.stringMatching(/\/api\/webhooks\/meta$/), status: 200, ok: true }])
      expect(falso.webhookDoApp()).toMatchObject({ callback: expect.stringMatching(/\/api\/webhooks\/meta$/), authorization: `Bearer ${APP_ID}|segredo-${t}` })
      expect(falso.webhookDoApp()!.campos).toEqual(expect.arrayContaining(["messages", "messaging_postbacks", "comments", "standby"]))
      // Os tokens só vão no cabeçalho: nunca na URL.
      expect(falso.chamadas.filter(c => c.path.includes(`EAAG-e2e-${t}`) || c.path.includes(`segredo-${t}`) || c.path.includes(falso.tokenDaPagina))).toEqual([])
      expect(falso.chamadas.some(c => c.path.startsWith(`/v26.0/${PAGINA_ID}/`))).toBe(true)
      expect(falso.proibidas).toEqual([])

      // A mesma conta de novo: o banco barra e a mensagem diz como seguir (o 409 entre providers está no vitest; a Graph falsa só confere a conta pelo unificado).
      await page.getByRole("button", { name: "Conectar canal" }).first().click()
      const repetido = page.getByRole("dialog", { name: "Conectar canal" })
      await repetido.getByRole("radio", { name: "Instagram" }).check()
      await repetido.getByLabel("Token de acesso").fill(`EAAG-e2e-${t}`)
      await repetido.getByLabel("ID da conta do Instagram").fill(conta)
      await repetido.getByLabel("Chave secreta do app da Meta").fill(`segredo-${t}`)
      await repetido.getByRole("button", { name: "Conectar" }).click()
      await expect(repetido.getByText(/arquive-a em Configurações > Canais e conecte de novo/)).toBeVisible()
      // O 409 é a resposta esperada desta etapa: o navegador o registra no console e a jornada o aceita.
      erros.splice(0, erros.length, ...erros.filter(erro => !/status of 409/.test(erro)))
    } finally {
      await falso.fechar()
      sql([`DELETE FROM channels WHERE workspace_id='${WORKSPACE}' AND (external_id='${q(conta)}' OR external_id LIKE 'archived:%:${q(conta)}')`])
    }
  })

  /** Conexão unificada criada pela API (a parte 1 já cobre o formulário), com a Graph falsa no ar. A limpeza é do `finalmente`. */
  async function prepararConexao(t: string, pessoa: string) {
    const catalogo = await api<{ development?: { providerApiBase: string } }>("/api/connections/catalog")
    test.skip(!catalogo.development, "O engine precisa de DEV_PROVIDER_API_BASE (veja engine/.dev.vars.example) para falar com uma Graph API falsa.")
    const conta = `17841${Math.floor(Math.random() * 1e9) + 1e9}`, chave = `segredo-${t}`, igsid = `19${Math.floor(Math.random() * 1e9) + 1e9}`
    const falso = await subirInstagramUnificadoFalso(Number(new URL(catalogo.development!.providerApiBase).port), conta, `unificado_${t}`, pessoa)
    const conexao = (await api<{ connection: { id: string } }>("/api/connections", { method: "POST", body: JSON.stringify({ kind: "instagram", provider: "instagram_unified",
      displayName: `Instagram unificado ${t}`, credentials: { accessToken: `EAAG-e2e-${t}`, accountId: conta, appSecret: chave } }) })).connection.id
    // O webhook do app é assinado ao conectar (a Meta falsa conferiu o callback no motor): a conexão já nasce conectada.
    expect(falso.verificacoes).toEqual([{ callback: expect.stringMatching(/\/api\/webhooks\/meta$/), status: 200, ok: true }])
    expect((await api<{ status: string }>(`/api/connections/${conexao}`)).status).toBe("connected")
    const limpar = async () => {
      await falso.fechar()
      sql([`DELETE FROM channels WHERE workspace_id='${WORKSPACE}' AND (external_id='${q(conta)}' OR external_id LIKE 'archived:%:${q(conta)}')`])
    }
    return { conta, chave, igsid, falso, conexao, limpar }
  }

  // Parte 2 (ficha 03): uma DM assinada com a chave do app, pela rota compartilhada, vira contato e conversa na Caixa de entrada.
  test("receber: DM assinada entra pela rota compartilhada e aparece na Caixa de entrada; assinatura errada é recusada", async ({ page }) => {
    const t = novoTag(), pessoa = `Pessoa ${t}`
    const { conta, chave, igsid, falso, conexao, limpar } = await prepararConexao(t, pessoa)
    try {
      expect((await falso.receber(`chave-errada-${t}`, igsid, `mid.errada.${t}`, "não deve entrar")).status).toBe(401)
      expect(consulta(`SELECT 1 FROM inbound_events WHERE channel_id='${q(conexao)}'`)).toEqual([])
      expect((await falso.receber(chave, igsid, `mid.${t}`, `Oi, tudo bem? ${t}`)).status).toBe(200)

      await expect.poll(() => consulta<{ username: string; opted_in: number; janela: number }>(`SELECT username,opted_in,window_expires_at-${Date.now()} AS janela FROM contact_channels WHERE channel_id='${q(conexao)}' AND external_user_id='${igsid}'`)[0], { timeout: 30_000 })
        .toMatchObject({ username: "pessoa_unificada", opted_in: 1 })
      // Janela de 24 horas contada a partir da mensagem.
      const { janela } = consulta<{ janela: number }>(`SELECT window_expires_at-${Date.now()} AS janela FROM contact_channels WHERE channel_id='${q(conexao)}' AND external_user_id='${igsid}'`)[0]
      expect(janela).toBeGreaterThan(23 * 3600_000)
      expect(janela).toBeLessThanOrEqual(24 * 3600_000)
      // O perfil veio do host do unificado, com o token da conexão.
      expect(falso.perfis).toHaveLength(1)
      expect(falso.perfis[0].path).toMatch(new RegExp(`^/v26\\.0/${igsid}\\?fields=name,username,profile_pic`))
      expect(falso.perfis[0].authorization).toBe(`Bearer EAAG-e2e-${t}`)
      expect(falso.proibidas).toEqual([])

      await page.goto(`/${WORKSPACE}/inbox`)
      await page.getByRole("textbox", { name: /Buscar conversa/ }).fill(pessoa)
      const item = page.getByRole("button", { name: new RegExp(`${pessoa}, Instagram`) })
      await expect(item).toBeVisible()
      await item.click()
      await expect(page.getByRole("log", { name: "Histórico da conversa" }).getByText(`Oi, tudo bem? ${t}`)).toBeVisible()
      await expect(page.getByRole("button", { name: "Enviar pelo Instagram" })).toBeVisible()
      await page.screenshot({ path: test.info().outputPath("instagram-unificado-recebida.png") })
    } finally { await limpar() }
  })

  // Parte 3 (ficha 04): o fluxo com palavra-chave responde pelo graph.facebook.com (aqui, a Graph falsa) e a resposta humana sai pelo mesmo caminho.
  test("responder: fluxo por palavra-chave e resposta humana saem por POST /<ID>/messages da conexão unificada", async ({ page }) => {
    test.setTimeout(120_000)
    const t = novoTag(), pessoa = `Pessoa ${t}`, palavra = `quero${t}`, resposta = `Aqui está o guia ${t}`
    const { conta, chave, igsid, falso, conexao, limpar } = await prepararConexao(t, pessoa)
    const automacao = (await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: `Instagram unificado ${t}` }) })).id
    try {
      await api(`/api/automations/${automacao}/draft`, { method: "PUT", body: JSON.stringify({ graph: {
        nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} }, { id: "message", type: "message", position: { x: 360, y: 0 }, config: { blocks: [{ kind: "text", text: resposta }] } }],
        edges: [{ from: "trigger", port: "next", to: "message" }] } }) })
      // A DM de prova abre a janela de 24 h (não casa com a palavra-chave); a conexão segue conectada.
      expect((await falso.receber(chave, igsid, `mid.prova.${t}`, `prova ${t}`)).status).toBe(200)
      await expect.poll(async () => (await api<{ status: string }>(`/api/connections/${conexao}`)).status, { timeout: 30_000 }).toBe("connected")
      const gatilho = await gatilhoDeRascunho(automacao, conexao, palavra, `Palavra ${t}`)
      await api(`/api/automations/${automacao}/publish`, { method: "POST" })
      await api(`/api/automations/${automacao}/triggers/${gatilho}`, { method: "PATCH", body: JSON.stringify({ state: "active" }) })

      expect((await falso.receber(chave, igsid, `mid.${t}`, palavra)).status).toBe(200)
      await expect.poll(() => falso.mensagens.length, { timeout: 45_000 }).toBe(1)
      expect(falso.mensagens[0]).toMatchObject({ path: `/v26.0/${conta}/messages`, authorization: `Bearer EAAG-e2e-${t}`, body: { recipient: { id: igsid }, message: { text: resposta } } })
      // Nada foi para o host do login do Instagram nem para /me.
      expect(falso.proibidas).toEqual([])
      const gravada = consulta<{ delivery_status: string | null; external_message_id: string }>(`SELECT delivery_status,external_message_id FROM messages WHERE workspace_id='${WORKSPACE}' AND source='automation' AND external_message_id LIKE 'instagram:${q(conexao)}:%'`)
      expect(gravada).toHaveLength(1)
      expect(gravada[0].external_message_id).toBe(`instagram:${conexao}:${igsid}:mid.unificado.1`)

      await page.goto(`/${WORKSPACE}/inbox`)
      await page.getByRole("textbox", { name: /Buscar conversa/ }).fill(pessoa)
      await page.getByRole("button", { name: new RegExp(`${pessoa}, Instagram`) }).click()
      const historico = page.getByRole("log", { name: "Histórico da conversa" })
      await expect(historico.getByText(palavra)).toBeVisible()
      await expect(historico.getByText(resposta)).toBeVisible()
      await page.screenshot({ path: test.info().outputPath("instagram-unificado-resposta-fluxo.png") })

      // Resposta humana pela Caixa de entrada: mesmo caminho, mesma conta.
      const manual = `Resposta da equipe ${t}`
      await page.getByLabel("Sua resposta").fill(manual)
      await page.getByRole("button", { name: "Enviar pelo Instagram" }).click()
      await expect(historico.getByText(manual)).toBeVisible()
      await expect.poll(() => falso.mensagens.length, { timeout: 30_000 }).toBe(2)
      expect(falso.mensagens[1]).toMatchObject({ path: `/v26.0/${conta}/messages`, authorization: `Bearer EAAG-e2e-${t}`, body: { recipient: { id: igsid }, message: { text: manual } } })
      await expect(page.getByText(/Falha ao enviar|não foi enviada/i)).toHaveCount(0)
      await page.screenshot({ path: test.info().outputPath("instagram-unificado-resposta-humana.png") })
    } finally {
      await limpar()
      sql([`DELETE FROM automations WHERE id='${q(automacao)}'`])
    }
  })

  // Parte 4 (ficha 05): o editor lista as publicações da conexão unificada e um comentário simulado gera a resposta privada (e a pública) pelo graph.facebook.com.
  test("comentário: o editor lista as publicações da conexão unificada e o comentário simulado gera a resposta privada", async ({ page }, info) => {
    test.setTimeout(150_000)
    const t = novoTag(), pessoa = `Pessoa ${t}`
    const { conta, chave, igsid, falso, conexao, limpar } = await prepararConexao(t, pessoa)
    const automacao = (await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: `Comentário unificado ${t}` }) })).id
    try {
      await api(`/api/automations/${automacao}/draft`, { method: "PUT", body: JSON.stringify({ graph: {
        nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} }, { id: "message", type: "message", position: { x: 360, y: 0 }, config: { blocks: [{ kind: "text", text: "Seu guia está aqui." }, { kind: "button", id: "link", label: "Abrir guia", action: { type: "url", url: "https://example.com/guia" } }] } }],
        edges: [{ from: "trigger", port: "next", to: "message" }] } }) })
      // A primeira entrega assinada chega e a conexão segue conectada.
      expect((await falso.receber(chave, igsid, `mid.prova.${t}`, `prova ${t}`)).status).toBe(200)
      await expect.poll(async () => (await api<{ status: string }>(`/api/connections/${conexao}`)).status, { timeout: 30_000 }).toBe("connected")
      // A edição no celular está fora do escopo; a jornada edita em desktop.
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`/${WORKSPACE}/automations/${automacao}`)
      await passo(page, "Gatilho").click({ position: { x: 40, y: 16 } })
      await novoGatilho(page, "Instagram", /Comentários na publicação ou Reel/)
      await page.getByLabel("Nome do gatilho").fill(`Pedido do guia ${t}`)
      await page.getByRole("combobox", { name: "Conexão", exact: true }).click()
      await page.getByRole("option", { name: `Instagram unificado ${t}`, exact: true }).click()
      const criado = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith(`/automations/${automacao}/triggers`))
      await page.getByRole("button", { name: "Criar gatilho", exact: true }).click()
      const resposta = await criado
      expect(resposta.status()).toBe(201)
      const gatilho = (await resposta.json() as { id: string }).id
      // A lista vem da Graph falsa do unificado (graph.facebook.com, token da conexão), só pelo servidor.
      await page.getByRole("button", { name: "Escolher publicação", exact: true }).click()
      await expect(page.getByRole("option", { name: "Todas as publicações ou Reels" })).toBeVisible()
      await expect(page.getByRole("option", { name: /Outra publicação recente/ })).toBeVisible()
      await page.screenshot({ path: test.info().outputPath("instagram-unificado-publicacoes.png") })
      await page.getByRole("option", { name: /Outra publicação recente/ }).click()
      await page.getByRole("dialog").getByRole("button", { name: "Escolher", exact: true }).click()
      await expect(page.getByRole("region", { name: "Publicação alvo" })).toContainText("Outra publicação recente")
      expect(falso.chamadas.some(c => c.metodo === "GET" && c.path.startsWith(`/v26.0/${conta}/media`) && c.authorization === `Bearer EAAG-e2e-${t}`)).toBe(true)
      await page.getByRole("textbox", { name: "Nova palavra: Palavras que o comentário deve ter", exact: true }).fill("quero")
      await page.getByRole("textbox", { name: "Nova palavra: Palavras que o comentário deve ter", exact: true }).press("Enter")
      await page.getByRole("button", { name: "Adicionar resposta", exact: true }).click()
      await page.getByRole("textbox", { name: "Resposta 1", exact: true }).fill("Confira seu privado!")
      // Curtir comentário continua desligado no login unificado.
      await expect(page.getByRole("switch", { name: "Curtir comentário" })).toHaveCount(0)
      await page.getByRole("button", { name: "Salvar", exact: true }).click()
      await expect(page.getByText("Gatilho salvo", { exact: true })).toBeVisible()
      await page.getByRole("button", { name: "Publicar", exact: true }).click()
      await expect(page.getByText("Ao vivo", { exact: true })).toBeVisible()
      await api(`/api/automations/${automacao}/triggers/${gatilho}`, { method: "PATCH", body: JSON.stringify({ state: "active" }) })

      // Comentário em outra publicação não dispara; no post escolhido, sim.
      expect((await falso.comentar(chave, igsid, `comentario.outro.${t}`, "eu quero", "990001")).status).toBe(200)
      expect((await falso.comentar(chave, igsid, `comentario.${t}`, "eu quero", "990002")).status).toBe(200)
      await expect.poll(() => falso.mensagens.length, { timeout: 45_000 }).toBe(1)
      expect(falso.mensagens[0]).toMatchObject({ path: `/v26.0/${conta}/messages`, authorization: `Bearer EAAG-e2e-${t}`, body: { recipient: { comment_id: `comentario.${t}` } } })
      expect(falso.mensagens[0].body.message.attachment.payload).toMatchObject({ template_type: "button", text: "Seu guia está aqui.", buttons: [{ type: "web_url", url: "https://example.com/guia" }] })
      await expect.poll(() => falso.respostas.length, { timeout: 30_000 }).toBe(1)
      expect(falso.respostas[0]).toMatchObject({ path: `/v26.0/comentario.${t}/replies`, authorization: `Bearer EAAG-e2e-${t}`, body: { message: "Confira seu privado!" } })
      expect(falso.chamadas.filter(c => c.path.endsWith("/likes"))).toHaveLength(0)
      expect(falso.proibidas).toEqual([])
      await expect.poll(() => consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs WHERE channel_id='${q(conexao)}' AND automation_version_id IN (SELECT id FROM automation_versions WHERE automation_id='${q(automacao)}')`)[0]?.n).toBe(1)
      // Replay do mesmo comentário: sem segunda resposta.
      expect((await falso.comentar(chave, igsid, `comentario.${t}`, "eu quero", "990002")).status).toBe(200)
      await page.waitForTimeout(1500)
      expect(falso.mensagens).toHaveLength(1)
      await page.screenshot({ path: test.info().outputPath(`instagram-unificado-comentario-${info.project.name}.png`) })
    } finally {
      await limpar()
      sql([`DELETE FROM automations WHERE id='${q(automacao)}'`])
    }
  })

  // Parte 5 (ficha 06): "Atualizar conexão" confere token, mensagens e comentários pelo graph.facebook.com (conta lida por /<ID> e /me/permissions), "Trocar credencial" troca o token e a revisão da Meta lista as permissões.
  test("Atualizar conexão, Trocar credencial e revisão de recursos na conexão unificada", async ({ page }) => {
    test.setTimeout(150_000)
    const t = novoTag()
    const { conta, chave, igsid, falso, conexao, limpar } = await prepararConexao(t, `Pessoa ${t}`)
    const nome = `Instagram unificado ${t}`
    try {
      // A primeira entrega assinada chega e a conexão segue conectada.
      expect((await falso.receber(chave, igsid, `mid.prova.${t}`, `prova ${t}`)).status).toBe(200)
      await expect.poll(async () => (await api<{ status: string }>(`/api/connections/${conexao}`)).status, { timeout: 30_000 }).toBe("connected")
      await page.goto(`/${WORKSPACE}/settings/channels`)
      const cartao = page.getByRole("listitem").filter({ hasText: nome })
      const atualizar = cartao.getByRole("button", { name: "Atualizar conexão" })
      const resultado = page.getByRole("dialog", { name: "Conferência da conexão" })
      const linha = (rotulo: string) => resultado.getByRole("list", { name: "Resultado da conferência" }).getByRole("listitem").filter({ hasText: new RegExp(`^${rotulo}`) })

      // Tudo certo: itens ok, curtidas indisponível e o webhook reassinado na conta; nada chama /me.
      await atualizar.click()
      await expect(resultado).toBeVisible()
      for (const rotulo of ["Token de acesso", "Mensagens", "Comentários", "Webhook"]) await expect(linha(rotulo)).toContainText("Ok")
      await expect(linha("Curtidas em comentários")).toContainText("Indisponível")
      expect(falso.chamadas.some(c => c.metodo === "GET" && c.path === "/v26.0/me/permissions" && c.authorization === `Bearer EAAG-e2e-${t}`)).toBe(true)
      expect(falso.chamadas.some(c => c.metodo === "POST" && c.path.startsWith(`/v26.0/${conta}/subscribed_apps`))).toBe(true)
      // Atualizar conexão reassina o webhook do app (a Meta confere o callback de novo).
      expect(falso.verificacoes.length).toBeGreaterThanOrEqual(2)
      expect(falso.verificacoes.every(v => v.ok)).toBe(true)
      expect(falso.proibidas).toEqual([])
      await page.keyboard.press("Escape")
      await expect(resultado).toBeHidden()

      // Sem mensagens: o item falta, com o nome da permissão sem "business" e o caminho do login unificado; a conexão fica com erro.
      falso.estado.mensagens = false
      await atualizar.click()
      await expect(linha("Mensagens")).toContainText("Falta")
      await expect(linha("Mensagens")).toContainText("instagram_manage_messages")
      await expect(linha("Mensagens")).toContainText("Login do Facebook para Empresas > configuração")
      await expect(linha("Mensagens")).not.toContainText("instagram_business")
      await expect(linha("Comentários")).toContainText("Ok")
      await page.screenshot({ path: test.info().outputPath("instagram-unificado-falta-mensagens.png"), scale: "css" })
      await resultado.getByRole("button", { name: "Fechar", exact: true }).first().click()
      await expect(cartao.getByText("Com erro", { exact: true })).toBeVisible()
      await expect(cartao.getByText(/Faltam permissões: mensagens/)).toBeVisible()

      // Sem a lista de /me/permissions, a prova por leitura confere do mesmo jeito.
      falso.estado.mensagens = true
      falso.estado.permissoes = false
      await atualizar.click()
      for (const rotulo of ["Token de acesso", "Mensagens", "Comentários"]) await expect(linha(rotulo)).toContainText("Ok")
      await page.keyboard.press("Escape")
      await expect(cartao.getByText("Conectada", { exact: true })).toBeVisible()
      falso.estado.permissoes = true

      // Token vencido: a conferência manda gerar um token novo no passo certo do painel da Meta; o resto fica não conferido.
      falso.estado.tokenVencido = true
      await atualizar.click()
      await expect(linha("Token de acesso")).toContainText("Falta")
      await expect(linha("Token de acesso")).toContainText("venceu")
      await expect(linha("Token de acesso")).toContainText("API setup with Unified login > Gerar tokens de acesso")
      await expect(linha("Mensagens")).toContainText("Não conferido")
      await page.keyboard.press("Escape")
      await expect(cartao.getByText(/O token venceu/)).toBeVisible()

      // Trocar credencial: o token novo é conferido na conta, grava cifrado e a conexão volta a conectar.
      falso.estado.tokenVencido = false
      await cartao.getByRole("button", { name: "Trocar credencial" }).click()
      const trocar = page.getByRole("dialog", { name: "Trocar credencial" })
      await trocar.getByLabel("Token de acesso").fill(`EAAG-novo-${t}`)
      await trocar.getByRole("button", { name: "Trocar credencial" }).click()
      await expect(page.getByText("Credencial trocada.")).toBeVisible()
      expect(falso.chamadas.some(c => c.metodo === "GET" && c.path.startsWith(`/v26.0/${conta}?fields=id,username`) && c.authorization === `Bearer EAAG-novo-${t}`)).toBe(true)
      expect(await page.content()).not.toContain(`EAAG-novo-${t}`)
      // A troca não mexe no estado da conexão (ela ainda mostra o erro do token vencido); "Atualizar conexão" com o token novo volta a conectar.
      await page.reload()
      await atualizar.click()
      await expect(linha("Token de acesso")).toContainText("Ok")
      expect(falso.chamadas.filter(c => c.path.startsWith(`/v26.0/${conta}/conversations`)).at(-1)?.authorization).toBe(`Bearer EAAG-novo-${t}`)
      await page.keyboard.press("Escape")
      await expect(cartao.getByText("Conectada", { exact: true })).toBeVisible()

      // Revisão de recursos da Meta: as permissões do token, no formato real do login unificado.
      falso.estado.comentarios = false
      await cartao.getByRole("button", { name: "Revisão de recursos" }).click()
      const revisao = page.getByRole("dialog", { name: "Revisão de recursos" })
      for (const permissao of ["instagram_basic", "instagram_manage_messages", "instagram_manage_comments", "instagram_manage_insights", "instagram_content_publish", "instagram_manage_events", "public_profile"]) await expect(revisao.getByText(permissao, { exact: true })).toBeVisible()
      await expect(revisao.getByRole("listitem").filter({ hasText: "instagram_manage_comments" })).not.toContainText("Concedida")
      await page.screenshot({ path: test.info().outputPath("instagram-unificado-revisao.png"), scale: "css" })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      expect(falso.proibidas).toEqual([])
    } finally { await limpar() }
  })
})
