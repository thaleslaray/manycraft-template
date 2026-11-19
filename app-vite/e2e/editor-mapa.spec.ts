import { test, expect } from "./fixtures"
import { WORKSPACE, api, conexaoConectada, gatilhoDeRascunho, novoTag, sql, q, passo, valorEstavel, maisDaLateral } from "./helpers"

// Ticket 10 da paridade: a automação publicada abre primeiro a versão publicada, só leitura, com
// "Principais métricas"; "Editar automação" entra em edição; rascunho sem publicação abre direto em edição.
const grafo = (texto: string) => ({
  nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} }, { id: "message", type: "message", position: { x: 360, y: 0 }, config: { blocks: [{ kind: "text", text: texto }] } }],
  edges: [{ from: "trigger", port: "next", to: "message" }],
})

test.describe("Editor: mapa e moldura", () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "Mapa só no desktop.")
    await page.setViewportSize({ width: 1440, height: 900 })
  })

  test("publicada abre só leitura com métricas; Editar automação entra em edição e Publicar volta", async ({ page }) => {
    const tag = novoTag(), nome = `Mapa ${tag}`
    const id = (await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: nome }) })).id
    try {
      await api(`/api/automations/${id}/draft`, { method: "PUT", body: JSON.stringify({ graph: grafo("Texto publicado") }) })
      // Publicar sem gatilho é barrado: este gatilho nasce desligado só para a publicação passar.
      await gatilhoDeRascunho(id, await conexaoConectada(), `mapa${tag}`)
      await api(`/api/automations/${id}/publish`, { method: "POST" })
      // Rascunho posterior: a vista inicial continua sendo a publicada.
      await api(`/api/automations/${id}/draft`, { method: "PUT", body: JSON.stringify({ graph: grafo("Texto do rascunho") }) })
      await page.goto(`/${WORKSPACE}/automations/${id}`)

      await expect(page.getByRole("heading", { name: "Principais métricas" })).toBeVisible()
      await expect(page.getByRole("combobox", { name: "Filtrar métricas por gatilho" })).toBeVisible()
      for (const rotulo of ["Envios", "Contatos únicos", "E-mails", "Telefones"]) await expect(page.getByText(rotulo, { exact: true }).first()).toBeVisible()
      await expect(page.getByText("Você está vendo a versão publicada")).toBeVisible()
      await expect(passo(page, "Mensagem")).toContainText("Texto publicado")
      await expect(page.getByRole("group", { name: "Métricas da mensagem" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Publicar", exact: true })).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Adicionar passo" })).toHaveCount(0)

      await page.getByRole("button", { name: "Editar automação", exact: true }).click()
      await expect(page.getByRole("button", { name: "Publicar", exact: true })).toBeVisible()
      await expect(page.getByText("Salvo", { exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "Desfazer" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Refazer" })).toBeVisible()
      await expect(page.getByText("Toque no passo para editar")).toBeVisible()
      await expect(passo(page, "Mensagem")).toContainText("Texto do rascunho")
      await expect(page.getByRole("heading", { name: "Principais métricas" })).toHaveCount(0)
      await expect(page.getByRole("group", { name: "Métricas da mensagem" })).toHaveCount(0)

      // Menu do "+" em seções, com zoom em coluna.
      await page.getByRole("button", { name: "Adicionar passo" }).click()
      for (const secao of ["Passo inicial", "Conteúdo", "Lógica"]) await expect(page.getByRole("menu").getByText(secao, { exact: true })).toBeVisible()
      for (const item of ["Gatilho", "Ações", "Condição", "Esperar", "Iniciar automação"]) await expect(page.getByRole("menuitem", { name: item, exact: true })).toBeVisible()
      await page.keyboard.press("Escape")
      for (const nomeControle of ["Aproximar", "Afastar", "Enquadrar tudo"]) await expect(page.getByRole("button", { name: nomeControle })).toBeVisible()

      await page.getByRole("button", { name: "Publicar", exact: true }).click()
      await expect(page.getByText("Você está vendo a versão publicada")).toBeVisible()
      await expect(passo(page, "Mensagem")).toContainText("Texto do rascunho")
    } finally {
      sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(id)}'`])
    }
  })

  test("rascunho sem publicação abre direto em edição", async ({ page }) => {
    const nome = `Rascunho mapa ${novoTag()}`
    const id = (await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: nome }) })).id
    try {
      await page.goto(`/${WORKSPACE}/automations/${id}`)
      await expect(page.getByRole("button", { name: "Publicar", exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "Editar automação" })).toHaveCount(0)
      await expect(page.getByRole("heading", { name: "Principais métricas" })).toHaveCount(0)
      await expect(page.getByText("Toque no passo para editar")).toBeVisible()
    } finally {
      sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(id)}'`])
    }
  })

  test("abrir e fechar o painel do passo não muda o zoom nem o lugar do mapa", async ({ page }) => {
    const nome = `Painel mapa ${novoTag()}`
    const id = (await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: nome }) })).id
    try {
      await api(`/api/automations/${id}/draft`, { method: "PUT", body: JSON.stringify({ graph: grafo("Texto do passo") }) })
      await page.goto(`/${WORKSPACE}/automations/${id}`)
      await expect(page.getByRole("button", { name: "Publicar", exact: true })).toBeVisible()
      const viewport = () => page.locator(".react-flow__viewport").evaluate(el => getComputedStyle(el).transform)
      // O enquadramento inicial termina com uma animação curta: a referência é o valor que se repete.
      let antes = ""
      await expect.poll(async () => { const atual = await viewport(); const igual = atual === antes; antes = atual; return igual }).toBe(true)
      await passo(page, "Mensagem").click()
      await expect(page.getByRole("region", { name: "Mensagem" })).toBeVisible()
      // O painel sobrepõe o mapa: se o mapa fosse reenquadrado, o valor mudaria alguns instantes depois.
      await page.waitForTimeout(600)
      expect(await viewport()).toBe(antes)
      await page.getByRole("button", { name: "Fechar painel", exact: true }).click()
      await expect(page.getByRole("region", { name: "Mensagem" })).toHaveCount(0)
      await page.waitForTimeout(600)
      expect(await viewport()).toBe(antes)
    } finally {
      sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(id)}'`])
    }
  })

  test("lateral publicada só tem o filtro e os quatro cartões; Mais métricas e Chamada por vêm do menu ⋮", async ({ page }) => {
    const nome = `Lateral mapa ${novoTag()}`
    const id = (await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: nome }) })).id
    try {
      await api(`/api/automations/${id}/draft`, { method: "PUT", body: JSON.stringify({ graph: grafo("Texto publicado") }) })
      await api(`/api/automations/${id}/publish`, { method: "POST" })
      await page.goto(`/${WORKSPACE}/automations/${id}`)
      const lateral = page.getByRole("region", { name: "Métricas por gatilho" })
      await expect(lateral.getByRole("combobox", { name: "Filtrar métricas por gatilho" })).toBeVisible()
      for (const cartao of ["Envios", "Contatos únicos", "E-mails", "Telefones"]) await expect(lateral.getByRole("button", { name: new RegExp(`^${cartao}`) }).or(lateral.getByLabel(new RegExp(`^${cartao}`)))).toBeVisible()
      await expect(lateral.getByRole("combobox", { name: "Período das métricas" })).toHaveCount(0)
      await expect(page.getByRole("region", { name: "Chamada por" })).toHaveCount(0)
      await expect(page.getByRole("group", { name: "Mais métricas" })).toHaveCount(0)
      // Cada passo mostra Enviado, Entregue, Aberto e Clicado (traço onde o canal não informa).
      const numeros = page.getByRole("group", { name: "Métricas da mensagem" })
      for (const rotulo of ["Enviado", "Entregue", "Aberto", "Clicado"]) await expect(numeros.getByText(rotulo, { exact: true })).toBeVisible()

      await maisDaLateral(page, "Mais métricas")
      const mais = page.getByRole("group", { name: "Mais métricas" })
      await expect(mais.getByRole("combobox", { name: "Período das métricas" })).toBeVisible()
      await maisDaLateral(page, "Chamada por")
      await expect(page.getByRole("region", { name: "Chamada por" })).toBeVisible()
    } finally {
      sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(id)}'`])
    }
  })

  test("fluxo curto abre grande e centrado, fluxo longo abre legível no começo; com um passo escolhido a faixa fala de Shift", async ({ page }) => {
    const nome = `Quadro mapa ${novoTag()}`
    const id = (await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: nome }) })).id
    const zoom = () => page.locator(".react-flow__viewport").evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a)
    try {
      await api(`/api/automations/${id}/draft`, { method: "PUT", body: JSON.stringify({ graph: grafo("Texto do passo") }) })
      await page.goto(`/${WORKSPACE}/automations/${id}`)
      await expect(page.getByRole("button", { name: "Publicar", exact: true })).toBeVisible()
      // Centrado: o meio dos passos cai no meio do mapa (o enquadramento termina uma animação depois de medir os passos).
      const desvio = async () => {
        const mapa = (await page.locator(".react-flow").boundingBox())!
        const caixas = await page.locator(".react-flow__node").evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }))
        const meioX = (Math.min(...caixas.map(c => c.x)) + Math.max(...caixas.map(c => c.x + c.w))) / 2
        const meioY = (Math.min(...caixas.map(c => c.y)) + Math.max(...caixas.map(c => c.y + c.h))) / 2
        return Math.max(Math.abs(meioX - (mapa.x + mapa.width / 2)), Math.abs(meioY - (mapa.y + mapa.height / 2)))
      }
      await expect.poll(desvio).toBeLessThan(30)
      const z = await valorEstavel(zoom)
      expect(z).toBeGreaterThanOrEqual(1)
      expect(z).toBeLessThanOrEqual(1.5)

      await expect(page.getByText("Toque no passo para editar")).toBeVisible()
      await passo(page, "Mensagem").click()
      await expect(page.getByText("Mantenha Shift pressionado e clique para selecionar vários passos")).toBeVisible()
      await page.getByRole("button", { name: "Fechar painel", exact: true }).click()

      // Fluxo longo: não encolhe até ficar ilegível; abre em zoom de leitura no começo do fluxo (o resto se alcança arrastando).
      const longo = { nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} }, ...Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, type: "message", position: { x: 360 * (i + 1), y: 0 }, config: { blocks: [{ kind: "text", text: `Passo ${i}` }] } }))],
        edges: Array.from({ length: 7 }, (_, i) => ({ from: i === 0 ? "trigger" : `m${i - 1}`, port: "next", to: `m${i}` })) }
      const idLongo = (await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: `${nome} longo` }) })).id
      await api(`/api/automations/${idLongo}/draft`, { method: "PUT", body: JSON.stringify({ graph: longo }) })
      await page.goto(`/${WORKSPACE}/automations/${idLongo}`)
      await expect(page.getByRole("button", { name: "Publicar", exact: true })).toBeVisible()
      await expect.poll(zoom).toBeLessThan(1)
      expect(await valorEstavel(zoom)).toBeGreaterThanOrEqual(0.65)
      const mapaLongo = (await page.locator(".react-flow").boundingBox())!
      const primeiro = (await passo(page, "Mensagem", "Passo 0").boundingBox())!
      expect(primeiro.x).toBeGreaterThanOrEqual(mapaLongo.x)
      expect(primeiro.x + primeiro.width).toBeLessThanOrEqual(mapaLongo.x + mapaLongo.width)
    } finally {
      sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND name LIKE '${q(nome)}%'`])
    }
  })
})
