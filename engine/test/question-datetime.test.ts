import { describe, expect, it } from 'vitest'
import { parseDateTimeAnswer, questionAnswer, questionFieldType, questionSchema } from '../src/schemas/question'

const config = questionSchema.parse({ text: 'Quando?', answer_type: 'datetime', field_id: 'f', retry_message: 'Tente de novo.', max_attempts: 2, timeout: { value: 1, unit: 'minutes' } })

describe('pergunta de data e hora', () => {
  it('liga o tipo ao campo Data e hora', () => expect(questionFieldType('datetime')).toBe('datetime'))
  it.each([
    ['2026-10-24 14:30', '2026-10-24T17:30:00.000Z'],
    ['2026-10-24T14:30:15', '2026-10-24T17:30:15.000Z'],
    ['24/10/2026 14:30', '2026-10-24T17:30:00.000Z'],
    ['24/10/2026 às 14h30', '2026-10-24T17:30:00.000Z'],
    ['24/10/2026, 9:05', '2026-10-24T12:05:00.000Z'],
    ['2026-10-24T14:30Z', '2026-10-24T14:30:00.000Z'],
    ['2026-10-24T14:30:00+02:00', '2026-10-24T12:30:00.000Z'],
  ])('aceita %s', (answer, iso) => expect(questionAnswer(config, answer)).toBe(iso))
  it.each(['', 'amanhã', '2026-10-24', '24/10/2026', '30/02/2026 10:00', '24/10/2026 24:00', '24/10/2026 10:60', '2026-13-01 10:00', '2026-10-24T14:30+25:00'])('recusa %j', answer => expect(questionAnswer(config, answer)).toBeUndefined())
  it('usa o fuso do contato quando a resposta não traz fuso', () => {
    expect(parseDateTimeAnswer('24/10/2026 14:30', 'America/New_York')).toBe('2026-10-24T18:30:00.000Z')
    expect(parseDateTimeAnswer('24/10/2026 14:30', 'Asia/Tokyo')).toBe('2026-10-24T05:30:00.000Z')
    expect(parseDateTimeAnswer('24/10/2026 14:30', 'Fuso/Inexistente')).toBe('2026-10-24T17:30:00.000Z')
  })
  it('respeita horário de verão do fuso na data informada', () => {
    expect(parseDateTimeAnswer('15/01/2019 12:00', 'America/Sao_Paulo')).toBe('2019-01-15T14:00:00.000Z')
    expect(parseDateTimeAnswer('15/07/2026 12:00', 'America/New_York')).toBe('2026-07-15T16:00:00.000Z')
  })
})
