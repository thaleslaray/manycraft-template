import { test as base, expect } from "@playwright/test"
import { servidorNoAr } from "./helpers"

let noAr: boolean | undefined

/** `page` que falha o teste se a página logar erro no console ou lançar exceção. */
export const test = base.extend<{ erros: string[] }>({
  erros: [async ({ page }, use) => {
    const erros: string[] = []
    page.on("pageerror", e => erros.push(`exceção: ${e.message}`))
    page.on("console", m => {
      if (m.type() !== "error") return
      const url = m.location().url
      // Foto de contato do Telegram sem imagem devolve 404 de propósito; o painel cai nas iniciais.
      if (/\/api\/contacts\/[^/]+\/avatar/.test(url)) return
      // Foto de perfil vencida de contato real do Instagram: o CDN externo (fbcdn/cdninstagram) responde 403 e o painel cai nas iniciais. Só falha de imagem desses hosts; erro do próprio app continua reprovando.
      if (/^https:\/\/[^/]*\.(fbcdn\.net|cdninstagram\.com)\//.test(url) && /^Failed to load resource: the server responded with a status of 40[34]/.test(m.text())) return
      // Chromium informa o bloqueio esperado da prévia de e-mail sem permissão de scripts.
      if (url === "about:srcdoc" && m.text() === "Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set.") return
      erros.push(`console.error: ${m.text()} ${url}`)
    })
    await use(erros)
  }, { auto: true }],
})

test.beforeEach(async () => {
  noAr ??= await servidorNoAr()
  test.skip(!noAr, "Servidor não está rodando: suba `npm run dev:local` (painel 5173 + engine 8788) e rode de novo.")
})

test.afterEach(async ({ erros }) => {
  expect(erros, "A página não pode registrar erros no console").toEqual([])
})

export { expect }
