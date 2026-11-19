import { expect, it } from 'vitest'

it('nome de usuário: 3 a 35 caracteres, sem terminar em domínio', async () => {
  const { usernamePattern } = await import('../src/channels/meta-account')
  expect(usernamePattern.test('loja.da_ana')).toBe(true)
  expect(usernamePattern.test('ab')).toBe(false)
  expect(usernamePattern.test('loja.com')).toBe(false)
  expect(usernamePattern.test('loja ana')).toBe(false)
})
