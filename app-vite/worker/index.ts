import { Hono } from "hono"

const app = new Hono<{ Bindings: Env }>()

// O public/_headers só vale para o que sai do binding ASSETS: as respostas que o Worker monta (404, 503) levam o nosniff daqui.
// A do motor passa como veio (ele já manda o dele).
const noSniff = { "x-content-type-options": "nosniff" }

// A chamada ao motor via service binding não passa pelo log HTTP do wrangler do motor:
// registra aqui (sem query/headers/corpo) para aparecer em .dev-logs/engine.log.
app.use("/api/*", async (c, next) => {
  const t = Date.now()
  await next()
  console.log(`[panel-proxy] ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} (${Date.now() - t}ms)`)
})

// O navegador não aceita headers customizados no handshake WebSocket.
// Workspace é contexto de roteamento; autenticação e permissões continuam no engine.
app.all("/api/*", async (c) => {
  if (!c.env.ENGINE) return c.json({ error: "engine_unavailable" }, 503, noSniff)
  const incoming = c.req.raw
  let request = incoming
  const url = new URL(incoming.url)
  if (url.pathname === "/api/inbox/live" && incoming.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const workspace = url.searchParams.get("workspace")
    if (workspace) {
      url.searchParams.delete("workspace")
      request = new Request(url, incoming)
      request.headers.set("x-workspace", workspace)
    }
  }
  try {
    // Devolver a resposta original preserva o socket do upgrade 101 e os cookies.
    return await c.env.ENGINE.fetch(request)
  } catch {
    // Não expor URLs, headers, cookies ou mensagens de erro do backend.
    return c.json({ error: "engine_unavailable" }, 503, noSniff)
  }
})

// Arquivo com hash que não existe mais (aba aberta antes de uma publicação): 404 sem cache, nunca o index.html
// da SPA, que o cabeçalho imutável de /assets/* faria o navegador guardar no lugar do JS.
app.get("/assets/*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  if (res.ok && !(res.headers.get("content-type") ?? "").includes("text/html")) return res
  return new Response("Not found", { status: 404, headers: { "cache-control": "no-store", ...noSniff } })
})

app.notFound((c) => c.json({ error: "not_found" }, 404, noSniff))
export default app
