import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { ENGINE, WORKSPACE, api, novoTag, q, sql } from "./helpers"

// Ficha telas-paridade/40: o Início com saudação, "Comece aqui" e o checklist de primeiros passos calculado pelo motor,
// num espaço vazio e no mesmo espaço depois de ganhar canal, automação publicada, contato e equipe.
// O espaço vazio é um espaço de verdade no banco local; só a resposta de "qual é o meu espaço" aponta para ele
// (o auto-login de desenvolvimento sempre responde o espaço de demonstração).
type Checklist = { key: string; label: string; done: boolean }[]

async function abrirInicio(page: Page, ws: string) {
  await page.goto(`/${ws}/dashboard`)
  await expect(page.getByRole("heading", { level: 2, name: /^Olá/ })).toBeVisible()
}

test("Início: checklist de primeiros passos no espaço vazio e depois com dados", async ({ page }, info) => {
  test.setTimeout(120_000)
  page.setDefaultTimeout(15_000)
  const tag = novoTag(), ws = `e2e-vazio-${tag}`, nomeEspaco = `Espaço vazio ${tag}`
  try {
    sql([
      `INSERT INTO workspaces(id,name) VALUES ('${ws}','${q(nomeEspaco)}')`,
      `INSERT INTO workspace_members(id,workspace_id,user_id,role) SELECT 'e2e-dono-${tag}','${ws}',user_id,'owner' FROM workspace_members WHERE workspace_id='${WORKSPACE}' AND role='owner' ORDER BY created_at,id LIMIT 1`,
    ])
    await page.route("**/api/session/workspace", route => route.fulfill({ json: { workspace_id: ws, name: nomeEspaco, role: "owner", user_name: "Desenvolvimento" } }))
    const motor = async () => (await (await fetch(`${ENGINE}/api/dashboard`, { headers: { "x-workspace": ws } })).json() as { checklist: Checklist }).checklist
    const cartao = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Conclua a configuração do seu espaço", exact: true }) })
    const progresso = cartao.getByRole("progressbar", { name: "Progresso dos primeiros passos" })

    // Espaço vazio: nada feito, as três primeiras etapas a fazer, nenhum canal e o "Comece aqui" com três cartões.
    expect((await motor()).map(s => s.done)).toEqual([false, false, false, false, false])
    await abrirInicio(page, ws)
    await expect(cartao).toBeVisible()
    await expect(cartao.getByText("0 de 5 concluídos", { exact: true })).toBeVisible()
    await expect(progresso).toHaveAttribute("aria-valuenow", "0")
    await expect(cartao.getByRole("link")).toHaveText(["Conectar um canala fazer", "Criar a primeira automaçãoa fazer", "Publicar uma automaçãoa fazer"])
    await expect(page.getByText("Nenhum canal conectado ainda.", { exact: true })).toBeVisible()
    await expect(page.getByText(/^0\s*canais conectados$/)).toBeVisible()
    const comece = page.getByRole("region", { name: "Comece aqui" })
    await expect(comece.getByRole("heading", { name: "Comece aqui", exact: true })).toBeVisible()
    await expect(comece.getByRole("listitem")).toHaveCount(3)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath("inicio-vazio.png"), scale: "css", fullPage: true })
    // O passo leva para onde se resolve.
    await cartao.getByRole("link", { name: /Conectar um canal/ }).click()
    await expect(page).toHaveURL(new RegExp(`/${ws}/settings/channels$`))

    // Com canal conectado, automação publicada e um contato: quatro de cinco; falta a equipe, que sobe para o topo.
    sql([
      `INSERT INTO channels(id,workspace_id,type,external_id,status,display_name,connection_state) VALUES ('e2e-canal-${tag}','${ws}','telegram','e2e-canal-${tag}-ext','connected','Canal do espaço ${tag}','connected')`,
      `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('e2e-auto-${tag}','${ws}','Boas-vindas ${tag}','{"nodes":[],"edges":[]}')`,
      `INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('e2e-ver-${tag}','${ws}','e2e-auto-${tag}',1,'{"nodes":[],"edges":[]}')`,
      `UPDATE automations SET published_version_id='e2e-ver-${tag}',status='live' WHERE id='e2e-auto-${tag}'`,
      `INSERT INTO contacts(id,workspace_id,first_name,status) VALUES ('e2e-contato-${tag}','${ws}','Primeiro contato','subscribed')`,
    ])
    expect((await motor()).map(s => [s.key, s.done])).toEqual([["connect", true], ["automation", true], ["publish", true], ["first_contact", true], ["team", false]])
    await abrirInicio(page, ws)
    await expect(cartao.getByText("4 de 5 concluídos", { exact: true })).toBeVisible()
    await expect(page.getByText(/^1\s*canal conectado$/)).toBeVisible()
    await expect(page.getByText(/^1\s*contato$/)).toBeVisible()
    await expect(progresso).toHaveAttribute("aria-valuenow", "4")
    await expect(cartao.getByRole("link")).toHaveText(["Convidar alguém da equipea fazer", "Conectar um canalfeito", "Criar a primeira automaçãofeito"])
    await expect(page.getByRole("region", { name: "Canais", exact: true })).toContainText(`Canal do espaço ${tag}`)
    await page.screenshot({ path: info.outputPath("inicio-com-dados.png"), scale: "css", fullPage: true })

    // Com alguém na equipe, tudo feito: o cartão de primeiros passos sai.
    sql([`INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ('e2e-membro-${tag}','${ws}','e2e-usuario-${tag}','editor')`])
    expect((await motor()).every(s => s.done)).toBe(true)
    await abrirInicio(page, ws)
    await expect(page.getByRole("heading", { name: "Suas próximas melhores ações", exact: true })).toBeVisible()
    await expect(cartao).toHaveCount(0)
  } finally {
    sql([`DELETE FROM workspaces WHERE id='${ws}'`])
  }
})

test("Início: no espaço com dados o checklist mostrado é o que o motor calcula", async ({ page }, info) => {
  page.setDefaultTimeout(15_000)
  const checklist = (await api<{ checklist: Checklist }>("/api/dashboard")).checklist
  const feitos = checklist.filter(s => s.done).length
  await abrirInicio(page, WORKSPACE)
  const cartao = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Conclua a configuração do seu espaço", exact: true }) })
  if (feitos === checklist.length) await expect(cartao).toHaveCount(0)
  else {
    await expect(cartao.getByText(`${feitos} de ${checklist.length} concluídos`, { exact: true })).toBeVisible()
    const ordem = [...checklist.filter(s => !s.done), ...checklist.filter(s => s.done)].slice(0, 3)
    await expect(cartao.getByRole("link")).toHaveText(ordem.map(s => `${s.label}${s.done ? "feito" : "a fazer"}`))
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath("inicio-demo.png"), scale: "css" })
})
