import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { app } from '../../src/index'
import { origin } from '../auth-helpers'
import { receiveEmail } from '../../src/email-channel/receive'
import type { InboundEvent } from '../../src/integrations'
import { apiJson, sql, filaCapturada } from './jornada'
import { emailRecebido, mimeResposta, type EnviadaEmail } from './simulador-email'

export const REMETENTE = 'novidades@empresa.test'
export const CLIENTE = 'cliente@exemplo.test'

type EmailSalvo = { id: string; recipient: string; subject: string; text: string; html: string; status: string; message_id: string; reply_to: string; token: string; intent: string; sender_id: string; contact_id: string }

/** O que o painel faz: dados legais da empresa (isso conecta o canal) e um remetente próprio verificado (endereço, depois DNS). */
export async function conectarEmail() {
  const antes = await apiJson<any>('GET', 'email/settings')
  expect(antes.senders[0], 'o remetente da plataforma já nasce verificado').toMatchObject({ status: 'verified', isDefault: true })
  const depois = await apiJson<any>('PATCH', 'email/settings', { company: { name: 'Oficina Horizonte', address: 'Rua das Flores, 100 - São Paulo' } })
  expect(depois.company.name).toBe('Oficina Horizonte')
  const conexoes = await apiJson<any[]>('GET', 'connections')
  const canal = conexoes.find(c => c.kind === 'email')
  expect(canal, 'a conexão de e-mail deveria aparecer na lista de canais').toBeTruthy()
  expect(canal.status).toBe('connected')
  return canal.id as string
}

export async function verificarRemetente(address = REMETENTE, name = 'Oficina Horizonte') {
  const s = await apiJson<any>('POST', 'email/senders', { address, name }, 201)
  expect(s.status).toBe('unverified')
  const naoUsavel = await apiJson<any>('PATCH', `email/senders/${s.id}`, { isDefault: true }, 409).catch(e => { throw e })
  expect(naoUsavel.error ?? JSON.stringify(naoUsavel)).toMatch(/Verifique/)
  expect((await apiJson<any>('POST', `email/senders/${s.id}/verify`, { stage: 'address' })).status).toBe('dns_pending')
  expect((await apiJson<any>('POST', `email/senders/${s.id}/verify`, { stage: 'dns', warmupAccepted: true })).status).toBe('verified')
  await apiJson('PATCH', 'email/settings', { defaultSenderId: s.id })
  return s.id as string
}

/** Tudo que a plataforma "enviou" (em desenvolvimento o serviço de envio é simulado dentro do produto e fica nesta tabela). */
export async function enviadasNoProduto(): Promise<(EnviadaEmail & { status: string; id: string; intent: string })[]> {
  const linhas = await sql.todas<EmailSalvo>("SELECT * FROM email_messages WHERE workspace_id='a' ORDER BY created_at, rowid")
  return linhas.map(l => ({ id: l.id, status: l.status, intent: l.intent, para: l.recipient, texto: l.text, assunto: l.subject, de: '', html: l.html, botoes: [], bruto: l }))
}
export const emailsSalvos = () => sql.todas<EmailSalvo>("SELECT * FROM email_messages WHERE workspace_id='a' ORDER BY created_at, rowid")

/** O cliente abre o e-mail: o pixel de rastreio é uma rota pública do produto. */
export async function abrirEmail(token: string, bindings: any = env) {
  const r = await app.request(`${origin}/api/email-public/open/${token}.gif`, {}, bindings)
  expect(r.status).toBe(200)
}

/** O cliente responde: MIME real entregue ao handler `email` (o mesmo do Email Routing). Devolve o que foi para a fila e se foi recusado. */
export async function responderEmail(mail: Pick<EmailSalvo, 'message_id' | 'reply_to' | 'recipient'>, texto: string, messageId: string, extra: { data?: Date; assunto?: string; de?: string; emResposta?: string | null; para?: string } = {}) {
  const fila = filaCapturada()
  const para = extra.para ?? mail.reply_to
  const mime = mimeResposta({ de: extra.de ?? mail.recipient, para, assunto: extra.assunto ?? 'Re: Seu material', messageId, ...(extra.emResposta === null ? {} : { emResposta: extra.emResposta ?? mail.message_id }), texto, data: extra.data, nomeDe: 'Cliente Açaí' })
  const msg = emailRecebido(mime, extra.de ?? mail.recipient, para)
  await receiveEmail(msg as never, fila.bindings as never)
  return { recusada: msg.rejeicoes, eventos: fila.eventos as InboundEvent[] }
}

/** Remetente e ambiente de produção (binding EMAIL fingido) para provar o que o produto faz com cada erro do serviço de envio. */
export async function ambienteDeEnvio(sim: { send(o: any): Promise<unknown> }) {
  const { connectionRuntime } = await import('../../src/channels/core/runtime')
  const id = await conectarEmail()
  const rt = await connectionRuntime(env as never, 'a', id, { secrets: false })
  const producao = { ...env, APP_ENV: 'production', EMAIL: sim } as never
  return { id, connection: rt.connection, producao }
}
