import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

export const WORKSPACE = "demo-workspace"
// Portas padrão do `npm run dev:local`; E2E_PAINEL / E2E_ENGINE apontam para outro par de portas.
export const PAINEL = process.env.E2E_PAINEL ?? "http://localhost:5173"
export const ENGINE = process.env.E2E_ENGINE ?? "http://localhost:8788"
const engineDir = resolve(import.meta.dirname, "../../engine")
const stateArgs = process.env.E2E_STATE_PATH ? ["--persist-to", process.env.E2E_STATE_PATH] : []

// Prints das jornadas: por padrão em e2e/.resultados/prints/ (fora do git). Só E2E_PRINTS=1 grava nas pastas versionadas.
const DESTINOS_VERSIONADOS: Record<string, string> = { "clone-screens": "../../replica/clone-screens", "prontidao": "../../.scratch/prontidao" }

/** Pasta de prints (`clone-screens` ou `prontidao`); criada se não existir. */
export function pastaPrints(pasta: keyof typeof DESTINOS_VERSIONADOS | (string & {})): string {
  const dir = process.env.E2E_PRINTS === "1" && DESTINOS_VERSIONADOS[pasta]
    ? resolve(import.meta.dirname, DESTINOS_VERSIONADOS[pasta])
    : resolve(import.meta.dirname, ".resultados/prints", pasta)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Caminho de um print, ex.: `caminhoPrint("clone-screens/01-lista-desktop.png")`; o nome do arquivo não muda. */
export function caminhoPrint(relativo: string): string {
  const partes = relativo.split("/")
  const [raiz, ...resto] = partes
  const arquivo = resto.pop() ?? ""
  const dir = resolve(pastaPrints(raiz), ...resto)
  mkdirSync(dir, { recursive: true })
  return resolve(dir, arquivo)
}

/** Pixel PNG embutido: foto que carrega sem depender de rede nem do Telegram. */
export const FOTO_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

export async function servidorNoAr(): Promise<boolean> {
  try {
    const [painel, engine] = await Promise.all([
      fetch(PAINEL, { signal: AbortSignal.timeout(3000) }),
      fetch(`${ENGINE}/api/contacts?search=zzzz`, { headers: { "x-workspace": WORKSPACE }, signal: AbortSignal.timeout(3000) }),
    ])
    return painel.ok && engine.ok
  } catch {
    return false
  }
}

/** Roda SQL no D1 local do engine (o mesmo banco que o servidor de desenvolvimento usa). */
export function sql(statements: string[]): void {
  const dir = mkdtempSync(join(tmpdir(), "e2e-sql-"))
  const file = join(dir, "q.sql")
  writeFileSync(file, statements.map(s => s.trim().replace(/;?$/, ";")).join("\n"))
  try {
    execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--env", "dev", ...stateArgs, "--file", file], {
      cwd: engineDir, stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    })
  } catch (e) {
    const err = e as { stderr?: Buffer; stdout?: Buffer }
    throw new Error(`SQL falhou: ${err.stderr?.toString() || err.stdout?.toString() || e}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${ENGINE}${path}`, {
    ...init, headers: { "x-workspace": WORKSPACE, "content-type": "application/json", ...(init.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

/** Gatilho de palavra-chave criado pela API no passo `trigger`. Em rascunho ele nasce desligado e publicar sem gatilho é barrado: crie antes de publicar e ligue depois com `PATCH /api/automations/:id/triggers/:gatilho {state:"active"}`. */
export async function gatilhoDeRascunho(automacao: string, conexao: string, palavra: string, nome = "Gatilho e2e"): Promise<string> {
  return (await api<{ id: string }>(`/api/automations/${automacao}/triggers`, { method: "POST", body: JSON.stringify({ name: nome, connection_id: conexao, node_id: "trigger", words: [palavra], rule: "is" }) })).id
}
/** Primeira conexão conectada do tipo (as do seed do banco das jornadas). */
export async function conexaoConectada(tipo = "telegram"): Promise<string> {
  const lista = await api<{ id: string; kind: string; status: string }[]>("/api/connections")
  const achada = lista.find(c => c.kind === tipo && c.status === "connected")
  if (!achada) throw new Error(`Sem conexão ${tipo} conectada no banco das jornadas.`)
  return achada.id
}

const esc = (s: string) => s.replaceAll("'", "''")
export const q = esc

/** Guarda a foto e a descrição da conta; a função devolvida restaura o que havia (a foto só se ainda existir) e apaga a mídia que o teste subiu. */
export function guardarConta(): () => void {
  const antes = consulta<{ photo_media_id: string | null; description: string | null }>(`SELECT photo_media_id,description FROM workspaces WHERE id='${WORKSPACE}'`)[0]
  // As jornadas partem de uma conta sem foto nem descrição (o seed de paridade deixa as duas preenchidas); o que havia volta no fim.
  sql([`UPDATE workspaces SET photo_media_id=NULL, description=NULL WHERE id='${WORKSPACE}'`])
  return () => {
    const agora = consulta<{ photo_media_id: string | null }>(`SELECT photo_media_id FROM workspaces WHERE id='${WORKSPACE}'`)[0]?.photo_media_id
    const foto = antes.photo_media_id ? `(SELECT id FROM media_objects WHERE id='${q(antes.photo_media_id)}')` : "NULL"
    const descricao = antes.description === null ? "NULL" : `'${q(antes.description)}'`
    sql([`UPDATE workspaces SET photo_media_id=${foto}, description=${descricao} WHERE id='${WORKSPACE}'`,
      ...(agora && agora !== antes.photo_media_id ? [`DELETE FROM media_objects WHERE id='${q(agora)}'`] : [])])
  }
}

export function novoTag(): string {
  return Math.random().toString(36).slice(2, 8)
}

/** Canal de teste: existe só no banco local e nunca é o canal do bot real, então respostas não saem. */
export function canalE2eSql(canal: string, tipo = "telegram"): string[] {
  return [
    `INSERT OR IGNORE INTO channels(id,workspace_id,type,external_id,status,display_name) VALUES ('${canal}','${WORKSPACE}','${tipo}','${canal}-ext','connected','Canal de teste e2e')`,
  ]
}

export function contatoSql(o: { id: string; canal: string; nome: string; sobrenome: string; foto?: string; conversa?: { id: string; mensagens: { id: string; texto: string }[] } }): string[] {
  const now = Date.now()
  const cc = `${o.id}-cc`
  const out = [
    `INSERT INTO contacts(id,workspace_id,first_name,last_name,profile_pic_url,status,subscribed_at,last_interaction_at) VALUES ('${o.id}','${WORKSPACE}','${esc(o.nome)}','${esc(o.sobrenome)}',${o.foto ? `'${o.foto}'` : "NULL"},'subscribed',${now},${now})`,
    `INSERT INTO contact_channels(workspace_id,id,contact_id,channel_id,external_user_id,opted_in) VALUES ('${WORKSPACE}','${cc}','${o.id}','${o.canal}','${o.id}-ext',1)`,
  ]
  if (o.conversa) {
    out.push(`INSERT INTO conversations(id,workspace_id,contact_channel_id,unread,last_message_at) VALUES ('${o.conversa.id}','${WORKSPACE}','${cc}',0,${now})`)
    o.conversa.mensagens.forEach((m, i) => out.push(
      `INSERT INTO messages(workspace_id,id,conversation_id,direction,source,content,created_at) VALUES ('${WORKSPACE}','${m.id}','${o.conversa!.id}','in','contact','${esc(JSON.stringify({ sender: "contact", text: m.texto, status: "sent" }))}',${now + i})`,
    ))
  }
  return out
}

/** Remove só o que as jornadas criaram (ids com prefixo e2e-). */
export function limpezaSql(): string[] {
  const c = `workspace_id='${WORKSPACE}'`
  return [
    `DELETE FROM messages WHERE ${c} AND conversation_id LIKE 'e2e-%'`,
    `DELETE FROM conversations WHERE ${c} AND id LIKE 'e2e-%'`,
    `DELETE FROM contact_channels WHERE ${c} AND id LIKE 'e2e-%'`,
    `DELETE FROM contacts WHERE ${c} AND id LIKE 'e2e-%'`,
    `DELETE FROM channels WHERE ${c} AND id LIKE 'e2e-%'`,
  ]
}

/** Consulta de leitura no D1 local (devolve as linhas). */
export function consulta<T = Record<string, unknown>>(comando: string): T[] {
  for (let attempt = 0; ; attempt++) {
    let out: string
    try {
      out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--env", "dev", ...stateArgs, "--json", "--command", comando], {
        cwd: engineDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      }).toString()
    } catch (error) {
      // O CLI pode falhar ao abrir o SQLite enquanto o motor atende outra leitura local.
      if (attempt === 2 || !/^\s*SELECT\b/i.test(comando)) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
      continue
    }
    return JSON.parse(out)[0].results as T[]
  }
}

/**
 * Passo de mensagem novo: o editor só pergunta o canal quando não dá para herdar do passo de origem ou do gatilho
 * e há mais de um canal ligado. Se a pergunta aparecer, escolhe `canal` (padrão: o primeiro da lista); se não,
 * o passo já nasceu com o canal herdado e, quando `canal` é outro, troca pelo seletor "Canal do passo".
 */
export async function escolherCanalDoPasso(page: import("@playwright/test").Page, canal?: string): Promise<void> {
  const dialogo = page.getByRole("dialog", { name: "Por qual canal vai esta mensagem?" })
  const seletor = page.getByRole("combobox", { name: "Canal do passo", exact: true })
  // Sem espera fixa: o que aparecer primeiro (a pergunta ou o seletor do painel) diz em que caso estamos.
  const apareceu = await Promise.race([
    dialogo.waitFor({ state: "visible" }).then(() => "pergunta" as const),
    seletor.waitFor({ state: "visible" }).then(() => "seletor" as const),
  ]).catch(() => null)
  if (apareceu === "pergunta") {
    await dialogo.getByRole("button", { name: canal ?? /^(Telegram|WhatsApp|Instagram|E-mail|Escolher depois)$/, exact: canal ? true : undefined }).first().click()
    return
  }
  if (!canal) return
  if (apareceu !== "seletor") throw new Error(`Nem a pergunta do canal nem o seletor "Canal do passo" apareceram (canal pedido: ${canal}).`)
  if ((await seletor.textContent())?.includes(canal)) return
  await seletor.click()
  await page.getByRole("option", { name: canal, exact: true }).click()
}

/** Ação do cabeçalho da página: botão no desktop, item do menu ⋮ "Mais ações" no celular. */
export async function acaoDoTopo(page: import("@playwright/test").Page, nome: string): Promise<void> {
  const botao = page.getByRole("button", { name: nome, exact: true })
  const mais = page.getByRole("button", { name: "Mais ações", exact: true })
  await Promise.race([botao.waitFor({ state: "visible" }), mais.last().waitFor({ state: "visible" })])
  if (await botao.isVisible()) { await botao.click(); return }
  await page.getByRole("button", { name: "Mais ações", exact: true }).last().click()
  await page.getByRole("menuitem", { name: nome, exact: true }).click()
}

/** Abre "Escolher existente" a partir do botão no escopo e escolhe a automação pelo nome. */
export async function escolherAutomacao(page: import("@playwright/test").Page, escopo: Pick<import("@playwright/test").Page, "getByRole">, nome: string, botao = "Escolher existente") {
  await escopo.getByRole("button", { name: botao, exact: true }).click()
  const janela = page.getByRole("dialog", { name: "Escolher automação existente", exact: true })
  await janela.getByRole("combobox", { name: "Buscar automação" }).fill(nome)
  await janela.getByRole("option", { name: new RegExp(`^${nome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( Pausada| Rascunho)?$`) }).click()
  await janela.getByRole("button", { name: "Escolher", exact: true }).click()
  await janela.waitFor({ state: "hidden" })
}

/**
 * Campo de escolha do sistema (não o seletor nativo): abre pelo nome acessível do campo e clica na opção pelo nome.
 * `escopo` limita onde o campo é procurado (janela, painel); a lista de opções abre num portal, então é buscada na página.
 */
export async function escolher(page: import("@playwright/test").Page, rotulo: string, opcao: string | RegExp, escopo: Pick<import("@playwright/test").Page, "getByRole"> = page): Promise<void> {
  await escopo.getByRole("combobox", { name: rotulo, exact: true }).click()
  await page.getByRole("option", { name: opcao, exact: typeof opcao === "string" }).click()
}

/** Passo do mapa pelo nome acessível ("Passo <tipo>: <começo do texto>"); ex.: `passo(page, "Gatilho")`, `passo(page, "Mensagem", "Oi")`. O nome muda com o texto do passo. */
export function passo(page: Pick<import("@playwright/test").Page, "getByRole">, tipo: string, texto?: string) {
  const escapar = (valor: string) => valor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return page.getByRole("group", { name: new RegExp(`^Passo ${escapar(tipo)}${texto ? `: ${escapar(texto)}` : "(:|\\.)"}`) })
}

/** Espera um número que anima (zoom do mapa) parar de mudar e devolve o valor final, sem pausa fixa. */
export async function valorEstavel(ler: () => Promise<number>): Promise<number> {
  const { expect } = await import("@playwright/test")
  let anterior = await ler()
  await expect.poll(async () => { const atual = await ler(); const parou = Math.abs(atual - anterior) < 0.001; anterior = atual; return parou }, { intervals: [150] }).toBe(true)
  return anterior
}

/**
 * Ação da automação aberta: botão no celular, item do menu "Mais ações da automação" (⋮) na barra do editor no desktop.
 * Com `so: "ver"` só confere que a ação existe (e fecha o menu), sem clicar.
 */
export async function acaoDaAutomacao(page: import("@playwright/test").Page, nome: string, so?: "ver"): Promise<void> {
  const { expect } = await import("@playwright/test")
  const botao = page.getByRole("button", { name: nome, exact: true })
  const mais = page.getByRole("button", { name: "Mais ações da automação", exact: true })
  const item = page.getByRole("menuitem", { name: nome, exact: true })
  // A tela pode trocar de celular para desktop no meio (o editor remonta): cada tentativa olha de novo qual das duas formas existe.
  // Se algo falhar antes do clique, toPass refaz a tentativa inteira; depois do clique nada mais pode falhar.
  await expect(async () => {
    if (await botao.isVisible()) { if (!so) await botao.click(); return }
    await mais.click({ timeout: 1500 })
    await expect(item).toBeVisible({ timeout: 1500 })
    if (so) await page.keyboard.press("Escape"); else await item.click()
  }).toPass({ timeout: 15_000 })
}

/**
 * "Mais métricas" e "Chamada por" da automação publicada: no desktop são itens do menu ⋮ do editor (a lateral só tem o filtro e os quatro cartões);
 * no celular, "Mais métricas" é um botão da lateral e "Chamada por" já está à vista.
 */
export async function maisDaLateral(page: import("@playwright/test").Page, nome: "Mais métricas" | "Chamada por"): Promise<void> {
  const { expect } = await import("@playwright/test")
  const botao = page.getByRole("button", { name: nome, exact: true })
  const mais = page.getByRole("button", { name: "Mais ações da automação", exact: true })
  await expect(botao.or(mais).or(page.getByRole("region", { name: nome, exact: true })).first()).toBeVisible()
  if (await botao.isVisible()) { await botao.click(); return }
  if (await mais.isVisible()) {
    await mais.click()
    await page.getByRole("menuitem", { name: nome, exact: true }).click()
  }
}

/** Abre um menu ⋮ (botão pelo nome acessível, ou um Locator) e escolhe o item pelo nome. */
export async function menuMais(page: import("@playwright/test").Page, gatilho: string | import("@playwright/test").Locator, item: string): Promise<void> {
  const botao = typeof gatilho === "string" ? page.getByRole("button", { name: gatilho, exact: true }) : gatilho
  await botao.click()
  await page.getByRole("menuitem", { name: item, exact: true }).click()
}

/** Editor de transmissão: abre o cartão "Público alvo" e adiciona a condição pelo "+ Condição" (Grupo de inscritos, Segmento salvo ou Atividade de e-mail). */
export async function adicionarCondicao(page: import("@playwright/test").Page, condicao: string): Promise<void> {
  const cartao = page.getByRole("button", { name: "Público alvo", exact: true })
  if ((await cartao.getAttribute("aria-expanded")) !== "true") await cartao.click()
  await page.getByRole("button", { name: "Condição", exact: true }).click()
  await page.getByRole("menuitem", { name: condicao, exact: true }).click()
}

/** Painel de mensagem: abre "Mais" na lista de blocos de conteúdo (Card, Galeria, Áudio, Vídeo, Lista de opções ficam ali). */
export async function abrirMaisBlocos(page: import("@playwright/test").Page): Promise<void> {
  const mais = page.getByRole("button", { name: "Mais", exact: true })
  if ((await mais.getAttribute("aria-expanded")) !== "true") await mais.click()
}

/** Pop-up "Iniciar automação quando…": clica "Novo gatilho" no nó do gatilho e escolhe, no canal indicado, o cartão cujo texto bate com `cartao`. */
export async function novoGatilho(page: import("@playwright/test").Page, canal: string, cartao: string | RegExp): Promise<void> {
  await page.getByRole("button", { name: "Novo gatilho", exact: true }).click()
  const dialogo = page.getByRole("dialog", { name: "Iniciar automação quando…" })
  await dialogo.getByRole("button", { name: canal, exact: true }).click()
  await dialogo.getByRole("button", { name: cartao }).first().click()
}

/** Painel de mensagem: abre as faixas de botão recolhidas (botão salvo aparece como faixa; clicar mostra o formulário). */
export async function abrirBotoes(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("list", { name: "Blocos da mensagem" }).waitFor()
  const fechados = page.getByRole("list", { name: "Blocos da mensagem" }).getByRole("button", { name: /^Editar botão /, expanded: false })
  while (await fechados.count()) await fechados.first().click()
}

/** Editor de transmissão: o conteúdo é o mapa de fluxo. Abre o primeiro passo de mensagem (pelo cabeçalho do nó, não por uma linha dele) e devolve a caixa do texto dele. */
export async function textoDoPasso(page: import("@playwright/test").Page, numero = 1): Promise<import("@playwright/test").Locator> {
  const mapa = page.getByRole("application", { name: "Mapa do conteúdo da transmissão" })
  // O título do passo (não o miolo, que tem texto e botões) seleciona o passo e abre o painel.
  await mapa.getByRole("group", { name: /^Passo Mensagem/ }).first().getByText("Enviar mensagem", { exact: true }).click()
  const caixa = page.getByRole("textbox", { name: `Texto do bloco ${numero}`, exact: true })
  await caixa.waitFor()
  return caixa
}

/** "Mais opções" do painel do passo (recolhido por padrão): abre se ainda estiver fechado. */
export async function abrirMaisOpcoes(page: import("@playwright/test").Page): Promise<void> {
  const botao = page.getByRole("button", { name: "Mais opções", exact: true })
  if ((await botao.getAttribute("aria-expanded")) !== "true") await botao.click()
}

/** Painel de Ações: cada ação é uma linha; o formulário abre ao clicar nela (a ação recém-criada já vem aberta). */
export async function abrirAcao(page: import("@playwright/test").Page, numero: number): Promise<void> {
  const linha = page.getByRole("button", { name: new RegExp(`^Ação ${numero}: `) })
  if ((await linha.getAttribute("aria-expanded")) !== "true") await linha.click()
}
