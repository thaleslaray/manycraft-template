import { defineConfig, devices } from "@playwright/test"

// Usa o servidor já rodando (npm run dev:local, porta 5173). Não sobe nada sozinho:
// se o painel não responder, cada teste pula com uma mensagem clara (ver fixtures.ts).
// Workers = 1: as jornadas compartilham o mesmo banco local (paralelo só entre ambientes isolados: scripts/e2e-paralelo.mjs).
// Celular só nas jornadas marcadas com @celular (tela, layout, prints e o núcleo); E2E_CELULAR_TUDO=1 roda tudo no celular.
// Trace desligado por padrão (pesa em toda jornada); E2E_TRACE=1 volta a guardar nas que falham.
// E2E_SAIDA troca a pasta de resultados (um ambiente paralelo não apaga a do outro).
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: process.env.E2E_SAIDA ?? "./.resultados",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: {
    // O sandbox do macOS pode impedir o rendezvous entre processos do Chromium.
    launchOptions: process.env.E2E_CHROMIUM_SINGLE_PROCESS === "1" ? { args: ["--single-process"] } : undefined,
    reuseContext: process.env.E2E_CHROMIUM_SINGLE_PROCESS === "1",
    baseURL: process.env.E2E_PAINEL ?? "http://localhost:5173",
    trace: process.env.E2E_TRACE === "1" ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
    locale: "pt-BR",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    { name: "mobile", grep: process.env.E2E_CELULAR_TUDO === "1" ? undefined : /@celular/, use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
})
