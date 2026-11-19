import type { Button, ChannelAdapter, ChannelCapabilities, Degradation, OutboundMessage } from './types'

const bytes = (s: string) => new TextEncoder().encode(s).length
const length = (s: string, caps: ChannelCapabilities) => caps.text.unit === 'bytes' ? bytes(s) : [...s].length
const unsupported = (detail: string) => ({ ok: false as const, reason: 'unsupported' as const, detail })

/** Lossless Unicode split; prefer paragraph/sentence boundaries, then code points. */
function split(text: string, caps: ChannelCapabilities): string[] {
  const result: string[] = []
  let rest = [...text]
  while (rest.length) {
    let end = 0, size = 0, boundary = 0
    for (const c of rest) {
      const n = caps.text.unit === 'bytes' ? bytes(c) : 1
      if (size + n > caps.text.maxLength) break
      size += n; end++
      if (/[\s.!?]/u.test(c)) boundary = end
    }
    if (!end) throw new Error('Text limit cannot fit a Unicode code point')
    if (end < rest.length && boundary > end / 2) end = boundary
    result.push(rest.slice(0, end).join(''))
    rest = rest.slice(end)
  }
  return result
}

export const fitMessage: ChannelAdapter['fit'] = (message, caps) => {
  const degraded: Degradation[] = []
  if (message.kind !== 'text') return unsupported(`Message kind ${message.kind} is not implemented by the text transport`)
  if (!message.text || !Number.isInteger(caps.text.maxLength) || caps.text.maxLength < 4) return unsupported('Invalid text or channel text limit')
  let buttons: Button[] = [...(message.buttons ?? [])]
  let text = message.text
  if (message.quickReplies?.length) {
    if (caps.quickReplies) return unsupported('Native quick replies require a channel transport')
    if (caps.buttons.maxPerMessage) buttons.push(...message.quickReplies.map(q => ({ type: 'postback' as const, ...q })))
    else text += '\n' + message.quickReplies.map((q, i) => `${i + 1}. ${q.title}`).join('\n')
    degraded.push({ kind: 'quick_replies_to_buttons' })
  }
  if (buttons.length && (!caps.buttons.maxPerMessage || !caps.buttons.titleMax)) return unsupported('Channel does not support buttons')
  for (const b of buttons) {
    if (!caps.buttons.types.includes(b.type)) return unsupported(`Button type ${b.type} is not supported`)
    if (b.type === 'postback' && (!b.id || bytes(b.id) > caps.buttons.payloadMaxBytes)) return unsupported('Button payload exceeds byte limit; use a short stored token')
    if (b.type === 'url') {
      try { if (!['https:', 'http:'].includes(new URL(b.url).protocol)) return unsupported('Invalid button URL') }
      catch { return unsupported('Invalid button URL') }
    }
    if (!b.title) return unsupported('Button title is empty')
  }
  buttons = buttons.map(b => {
    if ([...b.title].length <= caps.buttons.titleMax) return b
    degraded.push({ kind: 'text_truncated', at: caps.buttons.titleMax })
    return { ...b, title: [...b.title].slice(0, caps.buttons.titleMax - 1).join('') + '…' }
  })
  const texts = split(text, caps)
  if (texts.length > 1) degraded.push({ kind: 'text_split', parts: texts.length })
  const messages: OutboundMessage[] = texts.map(text => ({ kind: 'text', text }))
  if (buttons.length) {
    const groups = Math.ceil(buttons.length / caps.buttons.maxPerMessage)
    if (groups > 1) degraded.push({ kind: 'buttons_split', from: buttons.length, messages: groups })
    for (let i = 0; i < groups; i++) {
      const group = buttons.slice(i * caps.buttons.maxPerMessage, (i + 1) * caps.buttons.maxPerMessage)
      if (i === 0) messages[messages.length - 1] = { kind: 'text', text: texts[texts.length - 1], buttons: group }
      else messages.push({ kind: 'text', text: 'Mais opções:', buttons: group })
    }
  }
  if (messages.some(m => m.kind === 'text' && length(m.text, caps) > caps.text.maxLength)) return unsupported('Channel text limit exceeded')
  return { messages, degraded }
}
