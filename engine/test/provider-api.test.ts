import { describe, expect, it } from 'vitest'
import { providers, providerIds } from '../src/channels/providers'

// Lê o código-fonte dos adaptadores (sem node:fs, que não existe no workerd dos testes).
const fontes = import.meta.glob('../src/channels/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const fonte = (arquivo: string) => fontes[`../src/channels/${arquivo}`]

// Arquivo do adaptador e o trecho que ele precisa conter. O padrão é o próprio api.base;
// a UAZAPI não tem host fixo (o servidor é da conta do cliente) e o e-mail usa o binding do Worker, sem HTTP.
const adaptador: Record<(typeof providerIds)[number], { arquivo: string; trecho?: string }> = {
  telegram_bot: { arquivo: 'telegram-bot.ts' },
  meta_whatsapp_cloud: { arquivo: 'meta-whatsapp-cloud.ts' },
  uazapi: { arquivo: 'uazapi.ts', trecho: 'serverUrl' },
  instagram_unified: { arquivo: 'instagram-unified.ts' },
  messenger_page: { arquivo: 'messenger-page.ts' },
  zapi: { arquivo: 'zapi.ts' },
  cloudflare_email: { arquivo: 'cloudflare-email.ts', trecho: 'binding' },
}

describe('ficha do provedor: api', () => {
  it('todo provedor registrado tem adaptador mapeado', () => {
    expect(Object.keys(adaptador).sort()).toEqual([...providerIds].sort())
  })
  for (const id of providerIds) {
    it(`${id}: o adaptador chama o host da ficha`, () => {
      const meta = providers[id], { arquivo, trecho } = adaptador[id]
      const src = fonte(arquivo)
      expect(src, `fonte ${arquivo} não encontrada`).toBeTruthy()
      expect(src, `${arquivo} não contém ${trecho ?? meta.api.base}`).toContain(trecho ?? meta.api.base)
      expect(meta.api.docs).toMatch(/^docs-[a-z-]+$/)
    })
  }
})
