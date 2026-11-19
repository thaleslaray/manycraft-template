import { test, expect } from "./fixtures"
import { WORKSPACE, api, consulta, novoTag, q, sql, caminhoPrint, passo } from "./helpers"

type Trigger = { id: string; channel_id: string | null; name: string; type: string; active: boolean }
type Detalhe = { automation: { id: string; name: string; draft_graph: { nodes: { type: string }[] } }; triggers: Trigger[] }

test.describe("Editor de automação", () => {
  test("passo inicial mostra o gatilho e o canal certo", { tag: "@celular" }, async ({ page }, info) => {
    // Somente leitura: abre uma automação existente com gatilho, sem salvar nada.
    const lista = await api<{ id: string }[]>("/api/automations")
    let alvo: Detalhe | undefined
    let gatilho: (Trigger & { channel_id: string }) | undefined
    for (const a of lista) {
      const d = await api<Detalhe>(`/api/automations/${a.id}`)
      const concreto = d.triggers.find((t): t is Trigger & { channel_id: string } => Boolean(t.channel_id))
      if (concreto && d.automation.draft_graph.nodes.some(n => n.type === "message")) { alvo = d; gatilho = concreto; break }
    }
    test.skip(!alvo, "Nenhuma automação com gatilho para abrir.")
    const detalhe = alvo!
    const tipo = consulta<{ type: string }>(`SELECT type FROM channels WHERE id='${gatilho!.channel_id.replaceAll("'", "''")}'`)[0]?.type

    await page.goto(`/${WORKSPACE}/automations/${detalhe.automation.id}`)
    const rotulo = ({ telegram: "Telegram", whatsapp: "WhatsApp", instagram: "Instagram", messenger: "Messenger" } as Record<string, string>)[tipo ?? ""]
    expect(rotulo, `canal ${gatilho!.channel_id} sem rótulo conhecido`).toBeTruthy()

    // Em tela estreita o painel mostra os passos só para leitura, sem o mapa.
    if (info.project.name === "mobile") {
      await expect(page.getByRole("heading", { level: 1, name: detalhe.automation.name })).toBeVisible()
      const passos = page.getByRole("list", { name: "Passos da automação" }).getByRole("listitem")
      await expect(passos.first()).toContainText("Gatilho")
      await expect(passos.first()).not.toContainText("Sem configuração")
      await expect(passos.filter({ hasText: /\d\. Mensagem/ }).first()).toContainText(rotulo)
      return
    }
    await expect(page.getByRole("textbox", { name: "Nome da automação" })).toHaveValue(detalhe.automation.name)
    const inicial = passo(page, "Gatilho")
    await expect(inicial).toBeVisible()
    await expect(inicial).toContainText("Quando…")
    await expect(inicial).not.toContainText("Configure o gatilho")
    await expect(inicial.locator("p.text-sm").first()).not.toBeEmpty()
    await expect(passo(page, "Mensagem").first()).toContainText(rotulo)
  })
  test("passos salvos com espaçamento apertado não se cobrem ao abrir", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "Mapa só no desktop.")
    const tag = novoTag()
    const msg = (id: string, x: number) => ({ id, type: "message", position: { x, y: 0 }, config: { blocks: [{ kind: "text", text: `Olá ${id}` }] } })
    const grafos = {
      dois: { nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} }, msg("m", 250)], edges: [{ from: "trigger", port: "next", to: "m" }] },
      quatro: { nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} }, msg("a", 250), msg("b", 400), msg("c", 500)],
        edges: [{ from: "trigger", port: "next", to: "a" }, { from: "a", port: "next", to: "b" }, { from: "b", port: "next", to: "c" }] },
    }
    // Nó alto (galeria de 3 cards) logo acima de outro: a altura real, não a suposta, decide a separação.
    const card = (title: string) => ({ title, subtitle: "Detalhes da oficina", buttons: [{ type: "url", title: "Conhecer", url: "https://example.test/o" }] })
    Object.assign(grafos, { alto: { nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} },
      { id: "g", type: "message", position: { x: 400, y: 0 }, config: { blocks: [{ kind: "text", text: "Escolha" }, { kind: "gallery", aspectRatio: "horizontal", cards: [card("Um"), card("Dois"), card("Três")] }] } },
      { id: "baixo", type: "message", position: { x: 400, y: 260 }, config: { blocks: [{ kind: "text", text: "Olá baixo" }] } }],
      edges: [{ from: "trigger", port: "next", to: "g" }, { from: "g", port: "next", to: "baixo" }] } })
    const ids = Object.keys(grafos).map(k => `e2e-sobreposicao-${k}-${tag}`)
    sql(Object.entries(grafos).map(([k, g]) => `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('e2e-sobreposicao-${k}-${tag}','${WORKSPACE}','Sobreposição ${k} ${tag}','${q(JSON.stringify(g))}')`))
    try {
      await page.setViewportSize({ width: 1440, height: 900 })
      for (const [k, g] of Object.entries(grafos)) {
        const id = `e2e-sobreposicao-${k}-${tag}`
        await page.goto(`/${WORKSPACE}/automations/${id}`)
        await expect(page.locator(".react-flow__node")).toHaveCount(g.nodes.length)
        await expect(page.locator(".react-flow__node").first()).toBeVisible()
        const caixas = await page.locator(".react-flow__node").evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { id: e.getAttribute("data-id")!, l: r.left, r: r.right, t: r.top, b: r.bottom } }))
        for (const a of caixas) for (const b of caixas) {
          if (a.id >= b.id) continue
          expect(a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1, `${a.id} cobre ${b.id}`).toBe(false)
        }
        // O enquadramento inicial mostra todos os passos dentro do mapa.
        await expect.poll(async () => {
          const mapa = (await page.getByRole("application", { name: "Mapa da automação" }).or(page.locator(".react-flow")).first().boundingBox())!
          const nos = await page.locator(".react-flow__node").evaluateAll(els => els.map(e => e.getBoundingClientRect().right))
          return Math.max(...nos) <= mapa.x + mapa.width
        }).toBe(true)
        await page.screenshot({ path: caminhoPrint(`clone-screens/paridade-31-10/flow-sem-sobreposicao-${k}.png`) })
      }
      // Só reposicionou na tela: o grafo salvo continua com as posições originais.
      const salvo = await api<{ automation: { draft_graph: { nodes: { id: string; position: { x: number } }[] } } }>(`/api/automations/${ids[0]}`)
      expect(salvo.automation.draft_graph.nodes.find(n => n.id === "m")!.position.x).toBe(250)
      const alto = await api<{ automation: { draft_graph: { nodes: { id: string; position: { y: number } }[] } } }>(`/api/automations/${ids[2]}`)
      expect(alto.automation.draft_graph.nodes.find(n => n.id === "baixo")!.position.y).toBe(260)
    } finally {
      sql(ids.map(id => `DELETE FROM automations WHERE id='${id}'`))
    }
  })
})
