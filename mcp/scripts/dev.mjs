// MCP local ligado ao motor local: `npm run dev` (em mcp/), com o `npm run dev:local` do painel já rodando.
// O vínculo ENGINE acha o motor pelo registro de dev do wrangler; usa o mesmo registro do painel
// (app-vite/.wrangler/registry, ou DEV_REGISTRY_PATH quando o ambiente das jornadas usa outro).
// Porta: DEV_MCP_PORT (padrão 8790). O MCP responde em http://127.0.0.1:<porta>/mcp.
// Conectar por login: MCP_URL vira http://127.0.0.1:<porta> (todo token fica preso a esse endereço: use 127.0.0.1, não
// localhost) e PAINEL_URL vira o painel local (DEV_PAINEL_URL, ou http://localhost:<DEV_PANEL_PORT, padrão 5173>).
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const mcpDir = fileURLToPath(new URL("../", import.meta.url))
const registryPath = process.env.DEV_REGISTRY_PATH ?? fileURLToPath(new URL("../../app-vite/.wrangler/registry", import.meta.url))
const port = process.env.DEV_MCP_PORT ?? "8790"
const painel = process.env.DEV_PAINEL_URL ?? `http://localhost:${process.env.DEV_PANEL_PORT ?? "5173"}`
const args = ["node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--port", port, "--inspector-port", "0",
  "--var", `MCP_URL:http://127.0.0.1:${port}`, "--var", `PAINEL_URL:${painel}`,
  // Sem isto o wrangler dev entrega ao Worker a URL com o host da rota de produção (mcp.manycraft...), e o emissor, os
  // metadados e a conferência do destino do token saem com o endereço errado.
  "--local-upstream", `127.0.0.1:${port}`]
const filho = spawn(process.execPath, args, {
  cwd: mcpDir, stdio: "inherit",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_REGISTRY_PATH: registryPath, MINIFLARE_REGISTRY_PATH: registryPath },
})
filho.on("exit", code => { process.exitCode = code ?? 1 })
for (const sinal of ["SIGINT", "SIGTERM"]) process.on(sinal, () => filho.kill(sinal))
