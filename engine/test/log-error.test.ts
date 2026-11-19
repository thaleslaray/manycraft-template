import { describe, expect, it, vi } from 'vitest'
import { errorFields, logTaskError } from '../src/log-error'

describe('logTaskError', () => {
  it('registra rótulo, nome e mensagem do erro em JSON', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logTaskError('sequences_unavailable', new TypeError('D1_ERROR: no such table: x'))
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({ event: 'sequences_unavailable', error: 'TypeError', message: 'D1_ERROR: no such table: x' })
    spy.mockRestore()
  })
  it('corta mensagens longas e aceita valores que não são Error', () => {
    expect(errorFields(new Error('x'.repeat(1000))).message).toHaveLength(300)
    expect(errorFields('falhou')).toEqual({ error: 'string', message: 'falhou' })
  })
})
