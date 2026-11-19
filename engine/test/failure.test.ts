import { describe, expect, it } from 'vitest'
import { failureAction, failureNotice, recipientFailure } from '../src/channels/core/failure'

// Ficha wa-03: cada código da Meta tem um tratamento (inventario.md, seção de códigos de erro).
describe('tratamento dos códigos de falha', () => {
  it('131049 é o limite de marketing por contato: pula o contato, não pausa a transmissão', () => {
    expect(failureAction('131049')).toBe('skip')
    expect(recipientFailure({ ok: false, reason: 'rejected', code: '131049', detail: '' }, 'whatsapp')).toEqual({ status: 'skipped', reason: '131049' })
  })
  it('contato que saiu do marketing é pulado; falha real de entrega segue como falha com o código', () => {
    expect(recipientFailure({ ok: false, reason: 'rejected', code: '131050', detail: '' }, 'whatsapp').status).toBe('skipped')
    expect(recipientFailure({ ok: false, reason: 'rejected', code: '131026', detail: '' }, 'whatsapp')).toEqual({ status: 'failed', reason: '131026' })
  })
  it('outside_window vira 131047 só no WhatsApp; nos outros canais mantém o motivo', () => {
    const outside = { ok: false, reason: 'outside_window', window: 'standard', expiredAt: 0, canUseTemplate: false } as const
    expect(recipientFailure(outside, 'whatsapp')).toEqual({ status: 'failed', reason: '131047' })
    expect(recipientFailure(outside, 'messenger')).toEqual({ status: 'failed', reason: 'outside_window' })
    expect(recipientFailure(outside, 'instagram')).toEqual({ status: 'failed', reason: 'outside_window' })
  })
})

// Ficha wa-09: erros da Marketing Messages API (P/support/error-codes.md, seção Marketing Messages API) com motivo em pt-BR.
const refused = (code: string) => ({ ok: false, reason: 'rejected', code, detail: '' }) as const
it.each([
  ['131063', /desativado[\s\S]*Aceitar termos/],
  ['131055', /só aceita modelos de marketing/],
  ['134100', /só aceita modelos de marketing/],
  ['134101', /sincronizando[\s\S]*10 minutos/],
  ['134102', /não está habilitada[\s\S]*Verificar de novo/],
  ['131061', /preço máximo/],
  ['131062', /identificador de usuário/],
])('erro %s da Marketing Messages API tem motivo em pt-BR', (code, notice) => {
  expect(failureNotice(refused(code))).toMatch(notice)
})
it('erros da conta pausam a transmissão; o de um contato só pula o contato', () => {
  for (const code of ['131055', '134100', '134101', '134102', '131061']) expect(failureAction(code)).toBe('pause')
  expect(failureAction('131062')).toBe('skip')
})

it('token recusado (401) dos provedores de credencial colada: código neutro pausa a transmissão e o motivo é o detail do adaptador', () => {
  expect(failureAction('token_refused')).toBe('pause')
  const detail = 'O token foi recusado pelo provedor X. Use “Trocar credencial” em Canais.'
  expect(failureNotice({ ok: false, reason: 'rejected', code: 'token_refused', detail })).toBe(detail)
})
