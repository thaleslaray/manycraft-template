import { defineConfig, loadEnv, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { cloudflare } from "@cloudflare/vite-plugin"
import { emailStudioPlugin } from "./src/email-studio/build.mjs"
import { fileURLToPath } from "node:url"

// Build fora do modo fake: o seed de estudo (dados inventados) não entra no pacote; src/data/seed-empty.ts toma o lugar dele.
function seedOnlyInFake(mode: string): Plugin {
  const fake = (process.env.VITE_DATA_MODE ?? loadEnv(mode, process.cwd(), "VITE_").VITE_DATA_MODE) === "fake"
  const empty = fileURLToPath(new URL("./src/data/seed-empty.ts", import.meta.url))
  const dataDir = fileURLToPath(new URL("./src/data/", import.meta.url))
  return {
    name: "seed-so-no-fake", apply: "build", enforce: "pre",
    resolveId(source, importer) { return !fake && source === "./seed" && importer?.startsWith(dataDir) ? empty : null },
  }
}

export default defineConfig(({ mode }) => ({
  // Ambientes paralelos das jornadas (scripts/e2e-paralelo.mjs) usam cada um o seu cache de dependências; dividir um só faz um Vite apagar o do outro.
  cacheDir: process.env.DEV_VITE_CACHE_DIR || undefined,
  server: { watch: { ignored: ["**/e2e/.resultados/**"] } },
  // Ambientes paralelos (DEV_VITE_STATE_PATH): estado do worker do painel à parte (o padrão app-vite/.wrangler/state trava com SQLITE_BUSY)
  // e sem inspetor (três Vites subindo juntos escolhem a mesma porta livre e um cai com EADDRINUSE).
  plugins: [seedOnlyInFake(mode), emailStudioPlugin(), react(), tailwindcss(), cloudflare(process.env.DEV_VITE_STATE_PATH ? { persistState: { path: process.env.DEV_VITE_STATE_PATH }, inspectorPort: false } : undefined)],
  build: {
    rolldownOptions: {
      output: {
        // Vendor estável (React e roteador) num arquivo próprio: muda só quando a dependência muda, então o navegador reaproveita entre publicações.
        codeSplitting: {
          groups: [{ name: "vendor-react", test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/, priority: 20 }],
        },
      },
    },
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
}))
