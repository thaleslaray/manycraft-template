/**
 * Cloudflare Email Service fingido para o teste de prontidão: o binding `EMAIL` (Workers API `send`) e o e-mail MIME que o
 * Email Routing entrega ao handler `email`. Nada sai da máquina. Os códigos de erro são os da documentação do Email Service
 * (https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).
 */
import type { Enviada } from './simuladores'

export type EnviadaEmail = Enviada & { assunto: string; de: string; html: string }
export type FalhaEmail = { quando?: (opcoes: any) => boolean; vezes?: number; erro: () => Error }

const validar = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/
/** Erro como o do binding real: `code` seguro e mensagem sem dados sensíveis. */
export const erroEmail = (code: string, message = code) => Object.assign(new Error(message), { code })
export const errosEmail = {
  enderecoInvalido: () => erroEmail('E_VALIDATION_ERROR', 'to: invalid email address'),
  remetenteNaoVerificado: () => erroEmail('E_SENDER_NOT_VERIFIED', 'sender is not verified'),
  dominioIndisponivel: () => erroEmail('E_SENDER_DOMAIN_NOT_AVAILABLE', 'sender domain is not available'),
  destinatarioSuprimido: () => erroEmail('E_RECIPIENT_SUPPRESSED', 'recipient is suppressed'),
  limite: () => erroEmail('E_RATE_LIMIT_EXCEEDED', 'rate limit exceeded'),
  limiteDiario: () => erroEmail('E_DAILY_LIMIT_EXCEEDED', 'daily limit exceeded'),
  /** 5xx do serviço: o envio pode ou não ter acontecido. */
  interno: () => erroEmail('E_INTERNAL_SERVER_ERROR', 'internal error'),
  /** Queda de transporte sem código nenhum. */
  semCodigo: () => new Error('network connection lost'),
}

export class EmailBinding {
  enviadas: EnviadaEmail[] = []
  /** Toda chamada a `send`, inclusive as que falharam. */
  chamadas: any[] = []
  falhas: FalhaEmail[] = []
  /** Domínios remetentes que a conta tem verificados no Email Service. */
  dominiosVerificados = new Set<string>()
  private seq = 0
  constructor(...dominios: string[]) { dominios.forEach(d => this.dominiosVerificados.add(d)) }
  programar(f: FalhaEmail) { this.falhas.push(f); return this }
  /** Mesma assinatura do binding: devolve `{ messageId }` ou lança erro com `code`. */
  readonly send = async (opcoes: any) => {
    this.chamadas.push(opcoes)
    const idx = this.falhas.findIndex(f => !f.quando || f.quando(opcoes))
    if (idx >= 0) {
      const f = this.falhas[idx]
      f.vezes = (f.vezes ?? 1) - 1
      if (f.vezes <= 0) this.falhas.splice(idx, 1)
      throw f.erro()
    }
    const para = String(opcoes?.to ?? ''), de = typeof opcoes?.from === 'string' ? opcoes.from : String(opcoes?.from?.email ?? '')
    if (!para || !opcoes?.subject || !(opcoes?.text || opcoes?.html)) throw erroEmail('E_FIELD_MISSING', 'to, subject and a body are required')
    if (!validar.test(para) || /[\r\n]/.test(para)) throw errosEmail.enderecoInvalido()
    if (!validar.test(de)) throw erroEmail('E_VALIDATION_ERROR', 'from: invalid email address')
    if (/[\r\n]/.test(String(opcoes.subject))) throw erroEmail('E_VALIDATION_ERROR', 'subject: invalid')
    if (!this.dominiosVerificados.has(de.split('@')[1])) throw errosEmail.dominioIndisponivel()
    const messageId = `<sim-${(++this.seq).toString().padStart(6, '0')}@email.cloudflare.test>`
    this.enviadas.push({ para: para.toLowerCase(), texto: String(opcoes.text ?? ''), botoes: [], assunto: String(opcoes.subject), de, html: String(opcoes.html ?? ''), bruto: opcoes })
    return { messageId }
  }
}

// ───────────────────────────── MIME recebido (Email Routing → handler `email`) ─────────────────────────────
const qp = (texto: string) => [...new TextEncoder().encode(texto)].map(b => (b >= 33 && b <= 126 && b !== 61) || b === 32 ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`).join('').replace(/(.{70})(?=.)/g, '$1=\r\n')

export type MimeOpcoes = { de: string; para: string; assunto: string; messageId: string; emResposta?: string; referencias?: string; texto: string; data?: Date; nomeDe?: string }
/** Resposta de um cliente de e-mail comum: multipart/alternative, quoted-printable, citação da mensagem anterior. */
export function mimeResposta(o: MimeOpcoes): string {
  const limite = `----=_Part_${o.messageId.replace(/\W/g, '')}`
  const citacao = o.emResposta ? `\r\n\r\nEm qua., 21 de out. de 2026 às 10:00, Equipe <${o.para}> escreveu:\r\n> mensagem anterior` : ''
  return [
    `Received: from mail-ed1-f50.example.test (mail-ed1-f50.example.test [209.85.208.50]) by mx.cloudflare.test with ESMTPS; ${(o.data ?? new Date()).toUTCString()}`,
    `From: ${o.nomeDe ? `=?UTF-8?B?${btoa(unescape(encodeURIComponent(o.nomeDe)))}?= ` : ''}<${o.de}>`,
    `To: <${o.para}>`,
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(o.assunto)))}?=`,
    `Date: ${(o.data ?? new Date()).toUTCString()}`,
    `Message-ID: ${o.messageId}`,
    ...(o.emResposta ? [`In-Reply-To: ${o.emResposta}`, `References: ${o.referencias ?? o.emResposta}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${limite}"`,
    '',
    `--${limite}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    qp(o.texto + citacao),
    `--${limite}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    qp(`<div dir="ltr">${o.texto}</div>`),
    `--${limite}--`,
    '',
  ].join('\r\n')
}

/** O objeto que o Email Routing entrega ao handler `email`: o MIME só pode ser lido uma vez. */
export function emailRecebido(mime: string, de: string, para: string) {
  const bytes = new TextEncoder().encode(mime)
  const rejeicoes: string[] = []
  return {
    from: de, to: para, rawSize: bytes.byteLength,
    raw: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } }),
    setReject(motivo: string) { rejeicoes.push(motivo) },
    rejeicoes,
  }
}
