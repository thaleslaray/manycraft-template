import { test, expect } from "./fixtures"
import { WORKSPACE, api, novoTag, q, sql } from "./helpers"

const SECOES = [
  { nome: "Minhas automações", rota: "automations" },
  { nome: "Básico", rota: "automations/basic" },
  { nome: "Sequências", rota: "automations/sequences" },
  { nome: "Palavras-chave", rota: "automations/keywords" },
  { nome: "Regras", rota: "automations/rules" },
]

test("Automação: título na barra do topo e submenu com a seção aberta marcada", { tag: "@celular" }, async ({ page }) => {
  await page.goto(`/${WORKSPACE}/automations`)
  await expect(page.getByRole("heading", { name: "Automação", exact: true, level: 1 })).toBeVisible()
  const menu = page.getByRole("navigation", { name: "Seções de automação" })
  for (const s of SECOES) {
    const item = menu.getByRole("link", { name: s.nome, exact: true })
    await expect(item).toBeVisible()
    // Cada item tem um ícone antes do nome, como no original.
    await expect(item.locator("svg")).toHaveCount(1)
  }
  await expect(menu.getByRole("link", { name: "Minhas automações", exact: true })).toHaveAttribute("aria-current", "page")
  await expect(page.getByRole("tablist")).toHaveCount(0)

  await menu.getByRole("link", { name: "Sequências", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/${WORKSPACE}/automations/sequences$`))
  await expect(menu.getByRole("link", { name: "Sequências", exact: true })).toHaveAttribute("aria-current", "page")
  await expect(menu.getByRole("link", { name: "Minhas automações", exact: true })).not.toHaveAttribute("aria-current", "page")
  await expect(page.getByRole("heading", { name: "Automação", exact: true, level: 1 })).toBeVisible()
})

test("Automação: no desktop o submenu fica à esquerda do conteúdo, no celular vira faixa de uma linha", { tag: "@celular" }, async ({ page }, info) => {
  await page.goto(`/${WORKSPACE}/automations/basic`)
  const menu = page.getByRole("navigation", { name: "Seções de automação" })
  const itens = menu.getByRole("link")
  await expect(itens.first()).toBeVisible()
  const caixas = await itens.evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y } }))
  if (info.project.name === "mobile") {
    expect(new Set(caixas.map(c => Math.round(c.y))).size).toBe(1)
  } else {
    expect(new Set(caixas.map(c => Math.round(c.x))).size).toBe(1)
    expect(new Set(caixas.map(c => Math.round(c.y))).size).toBe(caixas.length)
    const conteudo = await page.getByRole("main").locator("h2").first().boundingBox()
    expect(conteudo!.x).toBeGreaterThan(caixas[0].x + 100)
  }
})

test("Automação: preferências que escondem Palavras-chave e Regras continuam valendo", { tag: "@celular" }, async ({ page }) => {
  const antes = await api<{ hide_keywords_tab: boolean; hide_rules_tab: boolean }>("/api/workspace-settings")
  try {
    await api("/api/workspace-settings", { method: "PATCH", body: JSON.stringify({ hide_keywords_tab: true, hide_rules_tab: true }) })
    await page.goto(`/${WORKSPACE}/automations`)
    const menu = page.getByRole("navigation", { name: "Seções de automação" })
    await expect(menu.getByRole("link", { name: "Sequências", exact: true })).toBeVisible()
    await expect(menu.getByRole("link", { name: "Palavras-chave", exact: true })).toHaveCount(0)
    await expect(menu.getByRole("link", { name: "Regras", exact: true })).toHaveCount(0)
    // A rota segue abrindo pelo endereço, e a seção aberta aparece no submenu.
    await page.goto(`/${WORKSPACE}/automations/rules`)
    await expect(menu.getByRole("link", { name: "Regras", exact: true })).toHaveAttribute("aria-current", "page")
  } finally {
    await api("/api/workspace-settings", { method: "PATCH", body: JSON.stringify({ hide_keywords_tab: antes.hide_keywords_tab, hide_rules_tab: antes.hide_rules_tab }) })
  }
})

test("Minhas automações: filtros no seletor do sistema e ⋮ do cartão visível dentro da tela, sem estourar a largura", { tag: "@celular" }, async ({ page }, info) => {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/${WORKSPACE}/automations`)
  for (const nome of ["Tipo de gatilho", "Estado do gatilho", "Filtrar por status"]) await expect(page.getByRole("combobox", { name: nome, exact: true })).toBeVisible()
  await expect(page.locator("select")).toHaveCount(0)
  await page.getByRole("combobox", { name: "Filtrar por status", exact: true }).click()
  await page.getByRole("option", { name: "Rascunho", exact: true }).click()
  await expect(page).toHaveURL(/status=draft/)

  await page.goto(`/${WORKSPACE}/automations`)
  const lista = page.getByRole("list", { name: "Automações", exact: true })
  const linha = lista.getByRole("listitem").filter({ has: page.getByRole("link") }).first()
  await expect(linha).toBeVisible()
  const menu = linha.getByRole("button", { name: /^Mais ações de / })
  // Com pastas e filtros acima, o primeiro cartão pode começar abaixo da primeira tela; a jornada confere o ⋮ dentro da largura, não a altura da rolagem.
  await menu.scrollIntoViewIfNeeded()
  await expect(menu).toBeInViewport()
  await expect(linha.getByRole("button", { name: /^(Pausar|Retomar) / })).toHaveCount(0)
  await menu.click()
  await expect(page.getByRole("menuitem", { name: "Duplicar", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const caixa = await menu.boundingBox()
  expect(caixa!.x + caixa!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
})

test("Minhas automações: a raiz traz só as soltas, a pasta abre com migalha e a visualização em lista guarda as métricas", { tag: "@celular" }, async ({ page }, info) => {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 })
  const tag = novoTag(), pasta = `Pasta ${tag}`, solta = `Solta ${tag}`, dentro = `Dentro ${tag}`
  try {
    const folder = await api<{ id: string }>("/api/folders", { method: "POST", body: JSON.stringify({ name: pasta }) })
    await api("/api/automations", { method: "POST", body: JSON.stringify({ name: solta }) })
    await api("/api/automations", { method: "POST", body: JSON.stringify({ name: dentro, folder_id: folder.id }) })
    await page.goto(`/${WORKSPACE}/automations`)
    await expect(page.getByRole("heading", { name: "Minhas automações", exact: true, level: 2 })).toBeVisible()
    const cartoes = page.getByRole("list", { name: "Automações", exact: true })
    // A busca varre todas as pastas; sem ela a raiz mostra só as soltas.
    await page.getByRole("textbox", { name: "Buscar automação", exact: true }).fill(tag)
    await expect(cartoes.getByRole("link", { name: dentro, exact: true })).toBeVisible()
    await page.getByRole("textbox", { name: "Buscar automação", exact: true }).fill("")
    await expect(cartoes.getByRole("link", { name: dentro, exact: true })).toHaveCount(0)
    await page.getByRole("textbox", { name: "Buscar automação", exact: true }).fill(solta)
    await expect(cartoes.getByRole("link", { name: solta, exact: true })).toBeVisible()
    await page.getByRole("textbox", { name: "Buscar automação", exact: true }).fill("")

    await page.getByRole("button", { name: `Abrir pasta ${pasta}`, exact: true }).click()
    const trilha = page.getByRole("navigation", { name: "Pastas", exact: true })
    await expect(trilha.getByRole("button", { name: "Minhas automações", exact: true })).toBeVisible()
    await expect(trilha.getByRole("heading", { name: pasta, level: 2 })).toBeVisible()
    await expect(trilha.getByRole("button", { name: `Renomear pasta ${pasta}`, exact: true })).toBeVisible()
    await expect(cartoes.getByRole("link", { name: dentro, exact: true })).toBeVisible()
    await expect(cartoes.getByRole("link", { name: solta, exact: true })).toHaveCount(0)

    await page.getByRole("button", { name: "Visualização no formato de lista", exact: true }).click()
    await expect(page.getByRole("table", { name: "Automações", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Visualização em cartões", exact: true }).click()
    await expect(cartoes).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND name LIKE '%${q(tag)}%'`, `DELETE FROM folders WHERE workspace_id='${WORKSPACE}' AND name LIKE '%${q(tag)}%'`])
  }
})

test("Minhas automações: o cartão mostra a miniatura do fluxo quando há passos, e o ícone quando não há", { tag: "@celular" }, async ({ page }) => {
  const tag = novoTag()
  const com = (await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: `Com passos ${tag}` }) })).id
  await api("/api/automations", { method: "POST", body: JSON.stringify({ name: `Sem passos ${tag}` }) })
  try {
    await api(`/api/automations/${com}/draft`, { method: "PUT", body: JSON.stringify({ graph: {
      nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} }, { id: "message", type: "message", position: { x: 360, y: 0 }, config: { blocks: [{ kind: "text", text: "Oi" }] } }],
      edges: [{ from: "trigger", port: "next", to: "message" }],
    } }) })
    await page.goto(`/${WORKSPACE}/automations?search=${encodeURIComponent(tag)}`)
    const cartoes = page.getByRole("list", { name: "Automações" }).getByRole("listitem")
    await expect(cartoes).toHaveCount(2)
    await expect(cartoes.filter({ hasText: `Com passos ${tag}` }).getByRole("img", { name: "Miniatura do fluxo: 2 passos", includeHidden: true })).toBeVisible()
    await expect(cartoes.filter({ hasText: `Sem passos ${tag}` }).getByRole("img", { name: /Miniatura do fluxo/, includeHidden: true })).toHaveCount(0)
  } finally {
    sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND name LIKE '%${q(tag)}%'`])
  }
})
