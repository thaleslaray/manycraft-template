/**
 * Conectar um aplicativo (Claude) pelo login (ficha 07 do MCP). O conector manda a pessoa para /conectar?pedido=<id>;
 * a tela lê no conector só o nome de quem pede e para onde vai o acesso, cria uma chave de perfil e devolve a resposta ao
 * conector por um formulário de verdade (navegação, não fetch): nada disso vai no endereço.
 */
import { pendingInviteKey } from "./team"

export const NOME_DA_CHAVE = "Claude (conector)"
/** Pedido guardado enquanto a pessoa entra na conta (o login volta para a tela com ele). */
export const pendingConsentKey = "pending-connector-request"

const MCP_LOCAL = "http://127.0.0.1:8790"
const MCP_PUBLICADO = "https://mcp.seu-dominio.example"

type EnvDoVite = { VITE_MCP_URL?: string; DEV?: boolean } | undefined

/** Endereço do conector: VITE_MCP_URL quando definida; senão o local no desenvolvimento e o publicado no build. */
export function enderecoDoConector(env: EnvDoVite = (import.meta as ImportMeta & { env?: EnvDoVite }).env): string {
  const definido = env?.VITE_MCP_URL?.trim()
  return (definido || (env?.DEV ? MCP_LOCAL : MCP_PUBLICADO)).replace(/\/+$/, "")
}

export const pedidoValido = (id: string | null | undefined): id is string => !!id && /^[0-9a-f]{64}$/.test(id)

export type PedidoDeConexao =
  | { estado: "ok"; cliente: string; dominio?: string; destino: string; local: boolean }
  | { estado: "vencido" }
  | { estado: "indisponivel" }

/** Lê no conector quem pede acesso. Sem cookie (outra origem); 404 é pedido vencido ou já usado. */
export async function lerPedido(id: string, mcp = enderecoDoConector(), buscar: typeof fetch = fetch): Promise<PedidoDeConexao> {
  if (!pedidoValido(id)) return { estado: "vencido" }
  let resposta: Response
  try { resposta = await buscar(`${mcp}/pedido/${id}`, { credentials: "omit", cache: "no-store" }) } catch { return { estado: "indisponivel" } }
  if (resposta.status === 404) return { estado: "vencido" }
  if (!resposta.ok) return { estado: "indisponivel" }
  const corpo = await resposta.json().catch(() => null) as { cliente?: unknown; dominio?: unknown; destino?: unknown; local?: unknown } | null
  if (!corpo || typeof corpo.cliente !== "string" || typeof corpo.destino !== "string") return { estado: "indisponivel" }
  return { estado: "ok", cliente: corpo.cliente, ...(typeof corpo.dominio === "string" ? { dominio: corpo.dominio } : {}), destino: corpo.destino, local: corpo.local === true }
}

export function camposDaAprovacao(o: { pedido: string; token: string; workspace: string; escopo: "read" | "write"; irreversiveis: boolean }) {
  return { pedido: o.pedido, decisao: "aprovar", token: o.token, workspace: o.workspace, irreversiveis: o.escopo === "write" && o.irreversiveis ? "permitir" : "" }
}

export const camposDaRecusa = (pedido: string) => ({ pedido, decisao: "negar" })

/** Posta os campos no /callback do conector com um formulário de verdade: o navegador sai da tela e segue o redirecionamento. */
export function enviarAoConector(campos: Record<string, string>, mcp = enderecoDoConector()): void {
  const form = document.createElement("form")
  form.method = "post"
  form.action = `${mcp}/callback`
  form.hidden = true
  for (const [nome, valor] of Object.entries(campos)) {
    const input = document.createElement("input")
    input.type = "hidden"
    input.name = nome
    input.value = valor
    form.append(input)
  }
  document.body.append(form)
  form.submit()
}

type Armazenamento = Pick<Storage, "getItem">

/** Para onde o login leva: convite pendente, depois pedido de conexão pendente, senão o início. */
export function destinoDepoisDoLogin(armazenamento: Armazenamento = sessionStorage): string {
  const pedido = armazenamento.getItem(pendingConsentKey)
  if (pedidoValido(pedido)) return `/conectar?pedido=${pedido}`
  return armazenamento.getItem(pendingInviteKey) ? "/invite" : "/"
}
