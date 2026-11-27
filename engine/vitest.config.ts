import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// PASSWORD_LOGIN '0': os testes rodam com a senha desligada mesmo que alguém a ligue no ambiente dev do wrangler.
const TEST_KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))   // same value as test/credentials.ts
export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
    miniflare: { bindings: { DEV_AUTO_LOGIN: '0', PASSWORD_LOGIN: '0', BETTER_AUTH_SECRET: 'local-test-secret-32-characters-at-least-for-T4', BETTER_AUTH_URL: 'https://engine.test', CONNECTIONS_KEK_V1: TEST_KEK, CONNECTIONS_KEK_ACTIVE: '1', TEST_MIGRATIONS: await readD1Migrations('./migrations') } },
  }))],
  test: {
    // Each file owns a workerd isolate; bound contention when several worktrees keep dev servers alive.
    maxWorkers: 4,
    ...(process.env.VITEST_MAX_WORKERS ? { maxWorkers: Number(process.env.VITEST_MAX_WORKERS) } : {}),
    ...(process.env.VITEST_TEST_TIMEOUT ? { testTimeout: Number(process.env.VITEST_TEST_TIMEOUT), hookTimeout: Number(process.env.VITEST_TEST_TIMEOUT) } : {}),
    // expect.poll espera um efeito que roda em segundo plano (fila, workflow). O padrão do Vitest é 1 s, pouco para
    // máquina carregada: o teste falhava com o código certo. A espera termina assim que o valor aparece.
    expect: { poll: { timeout: 10_000 } },
    setupFiles: ['./test/setup.ts'],
    include: ['./test/**/*.test.ts'],
  },
})
