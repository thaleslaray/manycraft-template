import { test, expect } from "./fixtures"
import { WORKSPACE, acaoDoTopo, api, caminhoPrint, conexaoConectada, escolher, gatilhoDeRascunho, novoTag, passo, q, sql } from "./helpers"
import type { Page } from "@playwright/test"

// Cartão "Escolha o primeiro passo" (como no original): numa automação sem nenhum passo além do gatilho, o mapa mostra, à
// direita do gatilho e ligado ao "Então", um cartão tracejado com as opções agrupadas (Conteúdo por canal, Lógica). Clicar
// cria o passo no lugar do cartão; o cartão some com o primeiro passo e volta quando todos são apagados. Não é um passo:
// não vai para o grafo salvo nem bloqueia a publicação. No celular as mesmas opções aparecem na lista de passos.
type Grafo = { nodes: { id: string; type: string; config: { channel?: string } }[]; edges: { from: string; port: string; to: string }[] }
const PRINTS = process.env.PRINTS_PRIMEIRO_PASSO

const cartaoDe = (page: Pick<Page, "getByRole">) => page.getByRole("region", { name: "Escolha o primeiro passo" })
const itensDo = (cartao: ReturnType<typeof cartaoDe>, grupo: string) => cartao.getByRole("group", { name: grupo, exact: true }).getByRole("button")
async function parado(page: Page, seletor: string) {
  const alvo = page.locator(seletor)
  let antes = { x: -1, y: -1, width: 0, height: 0 }
  await expect.poll(async () => { const agora = (await alvo.boundingBox())!; const igual = agora.x === antes.x && agora.y === antes.y && agora.width === antes.width; antes = agora; return igual }, { intervals: [300] }).toBe(true)
  return antes
}

test.describe("Editor: cartão do primeiro passo", () => {
  test("automação nova mostra o cartão ligado ao gatilho; escolher o canal cria a mensagem ligada; apagar faz o cartão voltar; publica", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "No celular o editor é a lista de passos (jornada abaixo).")
    await page.setViewportSize({ width: 1440, height: 900 })
    const tag = novoTag()
    const id = (await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: `Primeiro passo ${tag}` }) })).id
    try {
      // Gatilho no Telegram: o canal do fluxo é conhecido, então o Conteúdo traz o Telegram (e o E-mail, se ligado).
      await gatilhoDeRascunho(id, await conexaoConectada("telegram"), `primeiro${tag}`)
      await page.goto(`/${WORKSPACE}/automations/${id}`)
      await expect(passo(page, "Gatilho")).toBeVisible()
      const cartao = cartaoDe(page)
      await expect(cartao).toBeVisible()
      // Ligado ao "Então" por um conector com seta, à direita do gatilho e na mesma altura.
      await expect(page.locator('.react-flow__edge[data-id="first-step-edge"]')).toBeVisible()
      await expect(page.locator('.react-flow__edge[data-id="first-step-edge"] path[marker-end]')).toHaveCount(1)
      const caixaGatilho = await parado(page, '.react-flow__node[data-id="trigger"]')
      const caixaCartao = (await page.locator('.react-flow__node[data-id="first-step-card"]').boundingBox())!
      expect(caixaCartao.x).toBeGreaterThan(caixaGatilho.x + caixaGatilho.width)
      expect(Math.abs(caixaCartao.y - caixaGatilho.y)).toBeLessThan(4)
      // Legível no zoom inicial: o cartão cabe inteiro na tela.
      expect(caixaCartao.y + caixaCartao.height).toBeLessThan(900)

      // Grupos como no original, com os nomes do editor; IA não existe na réplica e o cartão não oferece Iniciar automação.
      await expect(cartao.getByRole("group")).toHaveCount(2)
      const conteudo = await itensDo(cartao, "Conteúdo").allTextContents()
      expect(conteudo[0]).toBe("Telegram")
      for (const canal of conteudo.slice(1)) expect(canal).toBe("E-mail")
      await expect(itensDo(cartao, "Lógica")).toHaveText(["Ações", "Condição", "Dividir caminhos", "Esperar"])
      await expect(cartao.getByRole("group", { name: "IA" })).toHaveCount(0)
      // Botões de verdade, alcançáveis pelo teclado, com foco visível.
      await itensDo(cartao, "Conteúdo").first().focus()
      await expect(itensDo(cartao, "Conteúdo").first()).toBeFocused()
      await page.keyboard.press("Tab")
      // O próximo botão do cartão: o segundo canal quando há conexão de e-mail (criada por outra jornada), senão o primeiro da Lógica.
      await expect(conteudo.length > 1 ? itensDo(cartao, "Conteúdo").nth(1) : itensDo(cartao, "Lógica").first()).toBeFocused()
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.screenshot({ path: caminhoPrint("primeiro-passo/01-cartao.png") })
      if (PRINTS) await page.screenshot({ path: `${PRINTS}/02-primeiro-passo.png` })
      // O cartão não é um passo: o rascunho não muda só por abrir o editor.
      await expect(page.getByText("Salvo", { exact: true })).toBeVisible()

      // Clicar no canal: a mensagem nasce nesse canal, no lugar do cartão, ligada ao "Então"; o cartão some.
      // Lugar do cartão no mapa (translate do nó), para comparar mesmo se o enquadramento mexer na tela enquanto o passo nasce.
      const noMapa = (el: Element) => { const m = new DOMMatrixReadOnly(getComputedStyle(el).transform); return { x: m.e, y: m.f } }
      const cartaoNoMapa = await page.locator(".react-flow__node-first_step").evaluate(noMapa)
      await itensDo(cartao, "Conteúdo").first().click()
      await expect(cartao).toHaveCount(0)
      const novo = page.locator(".react-flow__node-message")
      await expect(novo).toHaveCount(1)
      await expect(novo.getByText("Telegram", { exact: true })).toBeVisible()
      // No lugar do cartão, no mapa (a tela pode mexer com a máquina ocupada).
      await expect.poll(async () => { const p = await page.locator(".react-flow__node-message").evaluate(noMapa); return Math.max(Math.abs(p.x - cartaoNoMapa.x), Math.abs(p.y - cartaoNoMapa.y)) }, { timeout: 10_000 }).toBeLessThan(4)
      await expect(page.locator('.react-flow__edge[data-id="trigger:next"]')).toBeVisible()
      await expect(page.locator('.react-flow__edge[data-id="first-step-edge"]')).toHaveCount(0)
      await expect(page.getByRole("combobox", { name: "Canal do passo", exact: true })).toContainText("Telegram")
      const idNovo = (await novo.getAttribute("data-id"))!

      // Apagar o único passo traz o cartão de volta (e a ligação provisória ao "Então").
      await page.getByRole("button", { name: "Apagar passo", exact: true }).click()
      await expect(novo).toHaveCount(0)
      await expect(cartao).toBeVisible()
      await expect(page.locator('.react-flow__edge[data-id="first-step-edge"]')).toBeVisible()
      // "Desfazer" do aviso devolve o passo e o cartão some de novo.
      await page.locator("[data-sonner-toast] button[data-action]", { hasText: "Desfazer" }).click()
      await expect(novo).toHaveCount(1)
      await expect(cartao).toHaveCount(0)

      // Publicar: o cartão não é passo, não aparece no grafo e não barra a publicação.
      await novo.getByText("Enviar mensagem", { exact: true }).click()
      await page.getByRole("textbox", { name: "Texto do bloco 1", exact: true }).fill(`Olá ${tag}`)
      await page.getByRole("button", { name: "Publicar", exact: true }).click()
      await expect(page.getByText("Publicada · versão 1", { exact: true })).toBeVisible()
      const salvo = await api<{ automation: { draft_graph: Grafo }; published_version?: { graph: Grafo } }>(`/api/automations/${id}`)
      for (const g of [salvo.automation.draft_graph, salvo.published_version!.graph]) {
        expect(g.nodes.map(n => n.type).sort()).toEqual(["message", "trigger"])
        expect(g.nodes.find(n => n.id === idNovo)?.config.channel).toBe("telegram")
        expect(g.edges).toEqual([{ from: "trigger", port: "next", to: idNovo }])
      }
      // Versão publicada (só leitura): sem cartão.
      await expect(cartao).toHaveCount(0)
    } finally {
      sql([`DELETE FROM triggers WHERE workspace_id='${WORKSPACE}' AND automation_id='${q(id)}'`, `DELETE FROM automation_versions WHERE automation_id='${q(id)}'`, `DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(id)}'`])
    }
  })

  test("transmissão vazia: o início do envio ligado ao cartão, só com o canal da transmissão; a ajuda do tipo não cobre o mapa", { tag: "@celular" }, async ({ page }, info) => {
    const celular = info.project.name === "mobile"
    if (!celular) await page.setViewportSize({ width: 1864, height: 1033 })
    await page.goto(`/${WORKSPACE}/broadcasts`)
    await acaoDoTopo(page, "Nova transmissão")
    // O canal que vem escolhido é o primeiro conectado do banco local; se for o WhatsApp oficial, a tela pede modelo e não abre o mapa.
    await escolher(page, "Canal conectado", /marina_assistente_pessoal_bot/)
    const mapa = page.getByRole("application", { name: "Mapa do conteúdo da transmissão" })
    // A transmissão nasce com um passo de mensagem: sem cartão. Apagar o passo deixa o mapa vazio.
    const mensagem = mapa.locator(".react-flow__node-message")
    await expect(mensagem).toHaveCount(1)
    await expect(cartaoDe(mapa)).toHaveCount(0)
    await parado(page, ".react-flow__node-message")
    // Pelo teclado (passo focado + Delete): no celular, tocar no passo abre o painel por cima do mapa inteiro.
    await mensagem.focus()
    await page.keyboard.press("Delete")
    await expect(mapa.getByRole("group", { name: /^Passo Mensagem/ })).toHaveCount(0)
    const cartao = cartaoDe(mapa)
    await expect(cartao).toBeVisible()
    await expect(mapa.getByText("Você envia uma transmissão")).toBeVisible()
    await expect(page.locator('.react-flow__edge[data-id="broadcast-start-edge"]')).toBeVisible()
    const conteudo = await itensDo(cartao, "Conteúdo").allTextContents()
    expect(conteudo).toHaveLength(1)
    expect(["Telegram", "Instagram", "WhatsApp", "E-mail"]).toContain(conteudo[0])
    await expect(itensDo(cartao, "Lógica")).toHaveText(["Ações", "Condição", "Dividir caminhos", "Esperar"])
    if (celular) {
      // Celular: o mapa abre em zoom de leitura (o mesmo critério do relatório: pelo menos 70% do tamanho natural), começando
      // pelo início do envio; o título do cartão fica com pelo menos 12 px na tela.
      // A escala vem da transformação do mapa: dividir a largura na tela por offsetWidth (arredondado para inteiro) dava 0,74998 no
      // zoom 0,75 e o título de 16 px media 11,9997 px.
      const escala = () => cartao.evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el.closest(".react-flow__viewport") as HTMLElement).transform).a)
      await expect.poll(escala, { timeout: 10_000 }).toBeGreaterThanOrEqual(0.7)
      // O 0,7 chega no meio da animação do enquadramento: mede com o mapa parado (máquina lenta media 0,737 a caminho de 0,75).
      await parado(page, ".react-flow__node-first_step")
      const titulo = cartao.getByText("Escolha o primeiro passo")
      expect(await titulo.evaluate(el => parseFloat(getComputedStyle(el).fontSize)) * await escala()).toBeGreaterThanOrEqual(12)
      // Mapa estreito: o cartão fica abaixo do início (conector descendo até o topo dele) e os dois cabem juntos, sem arrastar.
      await parado(page, ".react-flow__node-first_step")
      const area = (await mapa.boundingBox())!
      const dentro = (b: { x: number; y: number; width: number; height: number }) => b.x >= area.x - 1 && b.y >= area.y - 1 && b.x + b.width <= area.x + area.width + 1 && b.y + b.height <= area.y + area.height + 1
      const inicio = (await mapa.locator(".react-flow__node-broadcast_start").boundingBox())!
      expect(dentro(inicio), "o início do envio cabe no mapa").toBe(true)
      const caixaCartao = (await mapa.locator(".react-flow__node-first_step").boundingBox())!
      expect(caixaCartao.y, "o cartão fica abaixo do início").toBeGreaterThan(inicio.y + inicio.height)
      expect(dentro((await titulo.boundingBox())!), "o título do cartão cabe no mapa").toBe(true)
      expect(dentro((await itensDo(cartao, "Conteúdo").first().boundingBox())!), "o item de canal cabe no mapa").toBe(true)
      expect(dentro(caixaCartao), "o cartão inteiro cabe no mapa").toBe(true)
    }
    // A ajuda do "Tipo da transmissão" (canais com janela de 24h) fica atrás do botão de informação: nada flutua sobre o mapa.
    const ajuda = page.getByRole("button", { name: "Ajuda: Tipo da transmissão", exact: true })
    if (await ajuda.count()) {
      await expect(page.getByText("Só chega a quem falou com você")).toHaveCount(0)
      await ajuda.click()
      await expect(page.getByRole("dialog", { name: "Ajuda: Tipo da transmissão" })).toContainText("Só chega a quem falou com você")
      await page.keyboard.press("Escape")
      await expect(page.getByRole("dialog", { name: "Ajuda: Tipo da transmissão" })).toHaveCount(0)
    }
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await cartao.scrollIntoViewIfNeeded()
    const sufixo = celular ? "-celular" : ""
    await page.screenshot({ path: caminhoPrint(`primeiro-passo/03-transmissao-vazia${sufixo}.png`) })
    if (PRINTS) await page.screenshot({ path: `${PRINTS}/04-transmissao-vazia${sufixo}.png` })
    // Com o mouse: nada cobre o item de canal.
    await itensDo(cartao, "Conteúdo").first().click()
    await expect(cartao).toHaveCount(0)
    await expect(mapa.getByRole("group", { name: /^Passo Mensagem/ })).toHaveCount(1)
    await expect(page.locator('.react-flow__edge[data-id="broadcast-start-edge"]')).toBeVisible()
  })

  test("celular: a lista de passos vazia oferece as mesmas opções agrupadas; escolher cria o passo", { tag: "@celular" }, async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "Jornada da lista de passos do celular.")
    const tag = novoTag()
    const id = (await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: `Primeiro passo celular ${tag}` }) })).id
    try {
      await page.goto(`/${WORKSPACE}/automations/${id}`)
      const cartao = cartaoDe(page)
      await expect(cartao).toBeVisible()
      await expect(cartao.getByRole("group")).toHaveCount(2)
      expect((await itensDo(cartao, "Conteúdo").allTextContents()).length).toBeGreaterThan(0)
      await expect(itensDo(cartao, "Lógica")).toHaveText(["Ações", "Condição", "Dividir caminhos", "Esperar"])
      await cartao.scrollIntoViewIfNeeded()
      await page.screenshot({ path: caminhoPrint("primeiro-passo/05-celular.png"), fullPage: true })
      if (PRINTS) await page.screenshot({ path: `${PRINTS}/05-celular.png`, fullPage: true })
      await itensDo(cartao, "Lógica").filter({ hasText: "Esperar" }).click()
      await expect(cartao).toHaveCount(0)
      const lista = page.getByRole("list", { name: "Passos da automação" })
      await expect(lista.getByRole("listitem")).toHaveCount(2)
      await expect(lista.getByRole("listitem").nth(1)).toContainText("2. Esperar")
      const salvo = await api<{ automation: { draft_graph: Grafo } }>(`/api/automations/${id}`)
      const espera = salvo.automation.draft_graph.nodes.find(n => n.type === "smart_delay")!
      expect(salvo.automation.draft_graph.edges).toEqual([{ from: "trigger", port: "next", to: espera.id }])
    } finally {
      sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(id)}'`])
    }
  })
})
