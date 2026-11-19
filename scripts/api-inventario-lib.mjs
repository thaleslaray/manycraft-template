// Cruza as rotas /api/* montadas num app Hono com as listas "só no painel" (bloqueadas para a chave)
// e "liberada por chave". Usado por scripts/api-inventario.mjs (app real) e pelo teste (app mínimo).
import { routeRegex } from "../engine/src/api-key-access.ts"

const METODOS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])

/** Rotas "MÉTODO /caminho" do painel: só /api/*, sem middleware (ALL), sem as montadas antes da sessão (`fora`). */
export function rotasDoApp(app, fora = () => false) {
  const rotas = new Set()
  for (const r of app.routes) {
    if (!METODOS.has(r.method) || !r.path.startsWith("/api/") || fora(r.path)) continue
    rotas.add(`${r.method} ${r.path.replace(/\/$/, "")}`)
  }
  return [...rotas]
}

const area = caminho => caminho.split("/")[2]

export function inventariar(app, { liberadas, bloqueadas, fora }) {
  const rotas = rotasDoApp(app, fora)
  const regras = bloqueadas.map(b => ({ ...b, regex: routeRegex(b.path), usada: false }))
  const lib = new Set(liberadas)
  const erros = [], linhas = []
  for (const rota of rotas) {
    const [metodo, caminho] = rota.split(" ")
    const bloq = regras.filter(b => (b.method === "*" || b.method === metodo) && b.regex.test(caminho))
    bloq.forEach(b => { b.usada = true })
    const liberada = lib.has(rota)
    if (bloq.length && liberada) erros.push(`rota nas duas listas: ${rota}`)
    else if (!bloq.length && !liberada) erros.push(`rota sem lista: ${rota}`)
    else linhas.push({ metodo, caminho, area: area(caminho), situacao: liberada ? "liberada" : "bloqueada" })
  }
  const montadas = new Set(rotas)
  for (const l of liberadas) if (!montadas.has(l)) erros.push(`liberada que sumiu: ${l}`)
  for (const b of regras) if (!b.usada) erros.push(`bloqueada que sumiu: ${b.method} ${b.path}`)
  const chave = l => `${l.area}\u0000${l.metodo} ${l.caminho}`
  linhas.sort((a, b) => chave(a) < chave(b) ? -1 : chave(a) > chave(b) ? 1 : 0)
  return { linhas, erros }
}

export function tabelaMarkdown(linhas) {
  const n = s => linhas.filter(l => l.situacao === s).length
  return [
    "# Inventário das rotas do painel (/api/*) para a chave de perfil",
    "",
    "Gerado por `node scripts/api-inventario.mjs` (roda no `npm run check`). Não edite à mão: mude",
    "`engine/src/api-rotas-liberadas.ts` (liberadas) ou `API_KEY_BLOCKED` em `engine/src/api-key-access.ts` (só no painel).",
    "",
    `Total: ${linhas.length} rotas — ${n("liberada")} liberadas, ${n("bloqueada")} bloqueadas.`,
    "",
    "| Método | Caminho | Área | Chave |",
    "|---|---|---|---|",
    ...linhas.map(l => `| ${l.metodo} | \`${l.caminho}\` | ${l.area} | ${l.situacao} |`),
    "",
  ].join("\n")
}
