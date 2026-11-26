import test from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { camposDaAprovacao, camposDaRecusa, destinoDepoisDoLogin, enderecoDoConector, lerPedido, pedidoValido, pendingConsentKey, NOME_DA_CHAVE } = await import("./conector.ts")
const { pendingInviteKey } = await import("./team.ts")

const PEDIDO = "a".repeat(64)

function armazenamento(inicial = {}) {
  const dados = new Map(Object.entries(inicial))
  return { getItem: k => dados.get(k) ?? null, setItem: (k, v) => dados.set(k, String(v)), removeItem: k => dados.delete(k) }
}

test("endereço do conector: variável do Vite, senão local no desenvolvimento e o publicado fora dele", () => {
  assert.equal(enderecoDoConector({ VITE_MCP_URL: "https://mcp.exemplo/" , DEV: true }), "https://mcp.exemplo")
  assert.equal(enderecoDoConector({ DEV: true }), "http://127.0.0.1:8790")
  assert.equal(enderecoDoConector({ DEV: false }), "https://mcp.seu-dominio.example")
  assert.equal(enderecoDoConector(undefined), "https://mcp.seu-dominio.example")
})

test("id do pedido: só 64 caracteres hexadecimais", () => {
  assert.equal(pedidoValido(PEDIDO), true)
  for (const ruim of [null, "", "a".repeat(63), "A".repeat(64), "g".repeat(64), `${PEDIDO}x`]) assert.equal(pedidoValido(ruim), false, String(ruim))
})

test("aprovar manda pedido, chave, espaço e irreversíveis só quando escreve e marcou", () => {
  assert.deepEqual(camposDaAprovacao({ pedido: PEDIDO, token: "perfil:abc", workspace: "w1", escopo: "write", irreversiveis: true }),
    { pedido: PEDIDO, decisao: "aprovar", token: "perfil:abc", workspace: "w1", irreversiveis: "permitir" })
  assert.equal(camposDaAprovacao({ pedido: PEDIDO, token: "perfil:abc", workspace: "w1", escopo: "write", irreversiveis: false }).irreversiveis, "")
  // "Só ler" nunca libera ações sem volta, mesmo que a caixa tenha ficado marcada.
  assert.equal(camposDaAprovacao({ pedido: PEDIDO, token: "perfil:abc", workspace: "w1", escopo: "read", irreversiveis: true }).irreversiveis, "")
})

test("cancelar manda só o pedido e a recusa", () => {
  assert.deepEqual(camposDaRecusa(PEDIDO), { pedido: PEDIDO, decisao: "negar" })
})

test("nome da chave criada", () => {
  assert.equal(NOME_DA_CHAVE, "Claude (conector)")
})

test("depois do login volta para a tela de conexão com o pedido guardado", () => {
  assert.equal(destinoDepoisDoLogin(armazenamento()), "/")
  assert.equal(destinoDepoisDoLogin(armazenamento({ [pendingConsentKey]: PEDIDO })), `/conectar?pedido=${PEDIDO}`)
  assert.equal(destinoDepoisDoLogin(armazenamento({ [pendingConsentKey]: "inventado" })), "/")
  assert.equal(destinoDepoisDoLogin(armazenamento({ [pendingInviteKey]: "convite" })), "/invite")
  assert.equal(destinoDepoisDoLogin(armazenamento({ [pendingConsentKey]: PEDIDO, [pendingInviteKey]: "convite" })), `/conectar?pedido=${PEDIDO}`)
})

test("lerPedido: 200 devolve o pedido; 404 é vencido; erro de rede é indisponível", async () => {
  const chamadas = []
  const responder = resposta => async (url, init) => { chamadas.push({ url, init }); if (resposta instanceof Error) throw resposta; return resposta }
  assert.deepEqual(await lerPedido(PEDIDO, "http://mcp", responder(Response.json({ cliente: "Claude", destino: "claude.ai", local: false }))),
    { estado: "ok", cliente: "Claude", destino: "claude.ai", local: false })
  assert.equal(chamadas[0].url, `http://mcp/pedido/${PEDIDO}`)
  assert.equal(chamadas[0].init.credentials, "omit")
  assert.deepEqual(await lerPedido(PEDIDO, "http://mcp", responder(Response.json({ error: "x" }, { status: 404 }))), { estado: "vencido" })
  assert.deepEqual(await lerPedido(PEDIDO, "http://mcp", responder(new Error("rede"))), { estado: "indisponivel" })
  assert.deepEqual(await lerPedido("ruim", "http://mcp", responder(Response.json({}))), { estado: "vencido" })
})
