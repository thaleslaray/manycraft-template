import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { configureMetaUserMenu } from '../src/channels/meta-surfaces'
import { actionSchema } from '../src/schemas/actions'

it('menu por contato: ação valida itens e o provedor recebe custom_user_settings (ou DELETE para voltar ao padrão)', async () => {
  expect(actionSchema.parse({ type: 'set_user_level_menu', items: [{ title: 'Ofertas', automation_id: 'auto-a' }] })).toBeTruthy()
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ result: "success" }))
  const ctx = { connection: { profile: { mainMenu: { maxItems: 20, titleMax: 30 } } }, credentials: { accessToken: 't' }, fetch } as never
  await configureMetaUserMenu(ctx, 'https://graph.example/v1', '123', [{ title: 'Ofertas', payload: 'usermenu:auto-a' }])
  expect(String(fetch.mock.calls[0][0])).toBe('https://graph.example/v1/me/custom_user_settings')
  expect(JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body))).toMatchObject({ psid: '123', persistent_menu: [{ call_to_actions: [{ payload: 'usermenu:auto-a' }] }] })
  await configureMetaUserMenu(ctx, 'https://graph.example/v1', '123', null)
  expect((fetch.mock.calls[1][1] as RequestInit).method).toBe('DELETE')
  void env
})
