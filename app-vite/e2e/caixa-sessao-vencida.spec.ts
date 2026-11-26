import { test, expect } from "@playwright/test"
import { WORKSPACE, servidorNoAr } from "./helpers"

// Sem as fixtures do painel: aqui o console registra de propósito a recusa do WebSocket e os 401.
test.beforeEach(async () => {
  test.skip(!(await servidorNoAr()), "Suba painel e motor locais para executar a jornada.")
})

test("sessão vencida: o canal ao vivo desiste e leva para o login em vez de tentar para sempre", async ({ page, context, baseURL }) => {
  // Guarda os sockets que a página abre, para derrubar o canal ao vivo como uma queda de rede faria.
  await page.addInitScript(() => {
    const Original = window.WebSocket
    const abertos: WebSocket[] = []
    ;(window as unknown as { __sockets: WebSocket[] }).__sockets = abertos
    window.WebSocket = new Proxy(Original, { construct(alvo, args) { const s = new alvo(...(args as [string])); abertos.push(s); return s } })
  })
  await page.goto(`/${WORKSPACE}/inbox`)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sockets: WebSocket[] }).__sockets.some(s => s.url.includes("/api/inbox/live") && s.readyState === 1))).toBe(true)

  // Sessão vencida como no publicado: o navegador ainda manda o cookie, o servidor não o aceita mais.
  await context.addCookies([{ name: "better-auth.session_token", value: "vencida", url: baseURL! }])
  let tentativas = 0
  page.on("websocket", ws => { if (ws.url().includes("/api/inbox/live")) tentativas++ })
  await page.evaluate(() => { for (const s of (window as unknown as { __sockets: WebSocket[] }).__sockets) if (s.url.includes("/api/inbox/live")) s.close() })

  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
  // Uma tentativa para descobrir a recusa; a espera crescente não chega a virar repetição.
  expect(tentativas).toBeLessThanOrEqual(2)
})
