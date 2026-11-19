import { test, expect } from "./fixtures"
import { WORKSPACE, api, novoTag, sql, q, passo, caminhoPrint, escolherCanalDoPasso } from "./helpers"
import type { Page } from "@playwright/test"

// Conector solto no vazio do mapa (como no original): arrastar da bolinha de saída e soltar onde não há passo abre, no
// ponto da soltura, a caixinha de próximos passos (agrupada como o cartão do primeiro passo). Escolher cria o passo ali, já ligado à saída; Cancelar ou Esc não criam nada.
type Grafo = { nodes: { id: string; type: string; position: { x: number; y: number } }[]; edges: { from: string; port: string; to: string }[] }

/** Ponto da tela em coordenadas do mapa, pelo transform do viewport agora (vale mesmo se o mapa se mexer depois). */
async function noMapa(page: Page, ponto: { x: number; y: number }) {
  return page.locator(".react-flow__viewport").evaluate((el, p) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform), base = (el.parentElement as HTMLElement).getBoundingClientRect()
    return { x: (p.x - base.x - m.e) / m.a, y: (p.y - base.y - m.f) / m.d, zoom: m.a }
  }, ponto)
}

/** Arrasta da bolinha "Então" do gatilho até um ponto vazio do mapa; devolve o ponto da soltura (na tela e no mapa). */
async function soltarNoVazio(page: Page): Promise<{ x: number; y: number; mapa: { x: number; y: number; zoom: number } }> {
  const bolinha = passo(page, "Gatilho").locator('.react-flow__handle[aria-label="Então"]')
  // O enquadramento do mapa anima depois de medir os passos: a posição da bolinha vale quando para de mudar.
  let caixa = { x: -1, y: -1, width: 0, height: 0 }
  await expect.poll(async () => { const agora = (await bolinha.boundingBox())!; const parou = agora.x === caixa.x && agora.y === caixa.y; caixa = agora; return parou }, { intervals: [300] }).toBe(true)
  const de = { x: caixa.x + caixa.width / 2, y: caixa.y + caixa.height / 2 }
  // À direita e acima do gatilho: vazio, com espaço para a caixinha abrir à direita do ponto (perto da borda ela vira para o outro lado).
  const ate = { x: de.x + 100, y: de.y - 250 }
  await page.mouse.move(de.x, de.y)
  await page.mouse.down()
  await page.mouse.move(de.x + 40, de.y - 20, { steps: 4 })
  await page.mouse.move(ate.x, ate.y, { steps: 12 })
  const mapa = await noMapa(page, ate)
  await page.mouse.up()
  return { ...ate, mapa }
}

test.describe("Editor: conector solto no vazio", () => {
  test.beforeEach(async ({ page }, info) => {
    // No celular o editor é a lista de passos (MobileSteps), sem mapa nem conectores para arrastar.
    test.skip(info.project.name !== "desktop", "Sem mapa no celular: o editor lá é a lista de passos.")
    await page.setViewportSize({ width: 1440, height: 900 })
  })

  test("soltar no vazio abre a caixinha; escolher cria o passo ligado ali; Desfazer remove; Cancelar e Esc não criam nada", async ({ page }) => {
    const id = (await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: `Conector solto ${novoTag()}` }) })).id
    try {
      await page.goto(`/${WORKSPACE}/automations/${id}`)
      await expect(page.getByRole("button", { name: "Publicar", exact: true })).toBeVisible()
      await expect(passo(page, "Gatilho")).toBeVisible()
      const passosAntes = await page.locator(".react-flow__node").count()

      const ponto = await soltarNoVazio(page)
      const menu = page.getByRole("menu", { name: "Próximo passo" })
      await expect(menu).toBeVisible()
      // Ancorada no ponto da soltura, à direita dele; conector provisório da saída até lá.
      const caixaMenu = (await menu.boundingBox())!
      expect(Math.abs(caixaMenu.x - ponto.x)).toBeLessThan(8)
      expect(caixaMenu.y).toBeLessThan(ponto.y)
      expect(caixaMenu.y + caixaMenu.height).toBeGreaterThan(ponto.y)
      await expect(page.locator('.react-flow__edge[data-id="connect-drop-edge"]')).toBeVisible()
      // Grupos como no cartão do primeiro passo (mesmo catálogo): Conteúdo (canal do fluxo ou os canais ligados), depois
      // Lógica, cada item com o ícone; Cancelar por último.
      await expect(menu.getByRole("group")).toHaveCount(2)
      await expect(menu.getByRole("group", { name: "Lógica", exact: true }).getByRole("menuitem")).toHaveText(["Ações", "Condição", "Dividir caminhos", "Esperar", "Iniciar automação"])
      expect(await menu.getByRole("group", { name: "Conteúdo", exact: true }).getByRole("menuitem").count()).toBeGreaterThan(0)
      await expect(menu.getByRole("group", { name: "IA" })).toHaveCount(0)
      const itens = await menu.getByRole("menuitem").allTextContents()
      expect(itens.slice(-6)).toEqual(["Ações", "Condição", "Dividir caminhos", "Esperar", "Iniciar automação", "Cancelar"])
      expect(itens.length).toBeGreaterThan(6)
      for (const canal of itens.slice(0, -6)) expect(["Instagram", "WhatsApp", "Telegram", "E-mail", "Mensagem"]).toContain(canal)
      await expect(menu.getByRole("menuitem").first()).toBeFocused()
      await menu.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)))
      await page.screenshot({ path: caminhoPrint("conector-solto/01-caixinha.png") })
      if (process.env.PRINTS_PRIMEIRO_PASSO) await page.screenshot({ path: `${process.env.PRINTS_PRIMEIRO_PASSO}/03-caixinha-grupos.png` })
      await page.keyboard.press("ArrowDown")
      await expect(menu.getByRole("menuitem").nth(1)).toBeFocused()
      await page.keyboard.press("ArrowUp")

      // Escolher a mensagem: o passo nasce com a entrada no ponto da soltura, ligado ao "Então".
      await menu.getByRole("menuitem").first().click()
      await escolherCanalDoPasso(page)
      await expect(menu).toHaveCount(0)
      const novo = passo(page, "Mensagem")
      await expect(novo).toHaveCount(1)
      await expect(page.locator('.react-flow__edge[data-id="connect-drop-edge"]')).toHaveCount(0)
      // Compara no mapa (translate do passo contra o ponto da soltura convertido na hora): com a máquina ocupada o enquadramento
      // inicial pode terminar depois da soltura e mover tudo na tela. Tolerâncias de antes (12 e 60 px na tela), no zoom da soltura.
      const nodoNovo = page.locator(".react-flow__node-message")
      await expect.poll(async () => nodoNovo.evaluate((el, p) => {
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform)
        return Math.abs(m.e - p.x) * p.zoom < 12 && Math.abs(m.f - p.y) * p.zoom < 60
      }, ponto.mapa), { timeout: 10_000 }).toBe(true)
      const idNovo = await page.locator(".react-flow__node-message").getAttribute("data-id")
      await expect(page.locator(`.react-flow__edge[data-id="trigger:next"]`)).toBeVisible()
      await page.screenshot({ path: caminhoPrint("conector-solto/02-passo-criado.png") })

      await page.getByRole("button", { name: "Salvar rascunho" }).click()
      await expect(page.getByText("Salvo", { exact: true })).toBeVisible()
      const salvo = await api<{ automation: { draft_graph: Grafo } }>(`/api/automations/${id}`)
      expect(salvo.automation.draft_graph.edges).toContainEqual({ from: "trigger", port: "next", to: idNovo })

      // Desfazer tira o passo e a ligação de uma vez.
      await page.getByRole("button", { name: "Desfazer" }).click()
      await expect(passo(page, "Mensagem")).toHaveCount(0)
      await expect(page.locator(`.react-flow__edge[data-id="trigger:next"]`)).toHaveCount(0)
      await expect(page.locator(".react-flow__node")).toHaveCount(passosAntes)

      // Cancelar: a caixinha fecha, o conector some e nada é criado.
      await soltarNoVazio(page)
      await expect(menu).toBeVisible()
      await menu.getByRole("menuitem", { name: "Cancelar" }).click()
      await expect(menu).toHaveCount(0)
      await expect(page.locator('.react-flow__edge[data-id="connect-drop-edge"]')).toHaveCount(0)
      await expect(page.locator(".react-flow__node")).toHaveCount(passosAntes)
      await expect(page.locator('.react-flow__edge:not([data-id="first-step-edge"])')).toHaveCount(0)

      // Esc também fecha sem criar.
      await soltarNoVazio(page)
      await expect(menu).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(menu).toHaveCount(0)
      await expect(page.locator(".react-flow__node")).toHaveCount(passosAntes)
      await expect(page.locator('.react-flow__edge:not([data-id="first-step-edge"])')).toHaveCount(0)
    } finally {
      sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(id)}'`])
    }
  })
})
