import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { claimNumber } from '../src/channels/core/whatsapp-numbers'
import { emailContact } from '../src/email-channel/store'
import { seed } from './fixtures'

beforeEach(seed)

it('número novo no WhatsApp junta com o contato que já tem esse telefone', async () => {
  await env.DB.prepare("UPDATE contacts SET phone='5511987654321' WHERE id='c-a'").run()
  expect(await claimNumber(env.DB, 'a', '+5511987654321', 'novo-contato', 'ch-a', 'Ana')).toBe('c-a')
  expect(await env.DB.prepare("SELECT count(*) n FROM contacts WHERE id='novo-contato'").first('n')).toBe(0)
  expect(await claimNumber(env.DB, 'a', '+5511912345678', 'outro', 'ch-a', 'Bia')).toBe('outro')
})

it('e-mail recebido junta com o contato que tem o endereço no cadastro', async () => {
  await env.DB.batch([
    env.DB.prepare("UPDATE contacts SET email='ana@oficina.com' WHERE id='c-a'"),
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id,status) VALUES ('mail-a','a','email','mail-a','connected')"),
  ])
  expect(await emailContact(env as never, 'a', 'mail-a', 'Ana@Oficina.com')).toBe('c-a')
  const other = await emailContact(env as never, 'a', 'mail-a', 'bia@oficina.com')
  expect(other).not.toBe('c-a')
})
