import { configureDataMode } from './api'

export type Session = { user: { emailVerified: boolean } } | null

/** Erro do motor de entrada: `code` e `status` decidem a mensagem; `serverMessage` é o texto que o motor mandou. */
export class AuthError extends Error {
  readonly code: string
  readonly status: number
  readonly serverMessage: string
  constructor(code: string, status: number, serverMessage = '') {
    super(code)
    this.code = code; this.status = status; this.serverMessage = serverMessage
  }
}

export async function authRequest<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new AuthError(data?.code ?? 'REQUEST_FAILED', response.status, typeof data?.message === 'string' ? data.message : '')
  return data as T
}

/** Tamanho do código de entrada enviado ao e-mail. */
export const CODIGO_TAMANHO = 6

/** Limpa o que a pessoa digitou ou colou no campo do código: fica só com os dígitos (sem espaços, traços ou letras), até 6. */
export function limparCodigo(valor: string): string {
  return valor.replace(/\D/g, '').slice(0, CODIGO_TAMANHO)
}

/** Pedir o código de entrada. A resposta é a mesma para qualquer e-mail: a tela não sabe (nem diz) se a conta existe. */
export const pedirCodigo = (email: string) => authRequest('email-otp/send-verification-otp', { email, type: 'sign-in' })
/** Entrar com o código recebido. Sucesso abre a sessão (cookie). */
export const entrarComCodigo = (email: string, otp: string) => authRequest('sign-in/email-otp', { email, otp })

/** Só no desenvolvimento: abre sessão com a conta de teste do seed, sem código (o motor responde 404 fora dele). */
export async function entrarComoTeste(): Promise<void> {
  const response = await fetch('/api/dev/sign-in', { method: 'POST', cache: 'no-store' })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new AuthError(data?.code ?? 'REQUEST_FAILED', response.status, typeof data?.message === 'string' ? data.message : '')
}

// Erros cuja mensagem o motor já manda em português, pronta para mostrar. O texto daqui só vale se a resposta vier sem mensagem.
const mensagensDoMotor: Record<string, string> = {
  MUITOS_PEDIDOS_DE_CODIGO: 'Muitos pedidos de código. Aguarde alguns minutos e tente de novo.',
  LIMITE_DIARIO_DE_CODIGOS: 'O limite diário de códigos de acesso foi atingido. Tente de novo amanhã ou entre com o Google.',
  EMAIL_NAO_CONFIGURADO: 'O envio de e-mail ainda não foi configurado. Entre com o Google ou fale com quem administra o sistema.',
  ENVIO_DO_CODIGO_FALHOU: 'Não foi possível enviar o código agora. Tente de novo em alguns minutos.',
  SIGNUP_CLOSED: 'O cadastro está fechado. Peça um convite a quem administra o espaço.',
}
// Erros do Better Auth (mensagem em inglês): o texto é daqui.
const mensagens: Record<string, string> = {
  INVALID_EMAIL: 'Confira o e-mail digitado. Ele precisa ser como voce@exemplo.com.',
  INVALID_OTP: 'Código incorreto. Confira os 6 dígitos no e-mail e tente de novo.',
  OTP_EXPIRED: 'Este código venceu. Peça um código novo para entrar.',
  TOO_MANY_ATTEMPTS: 'Muitas tentativas com este código. Peça um código novo para entrar.',
}

export function authErrorMessage(error: unknown): string {
  if (!(error instanceof AuthError)) return 'Não foi possível conectar. Confira sua conexão e tente de novo.'
  if (error.code in mensagensDoMotor) return error.serverMessage.trim() || mensagensDoMotor[error.code]
  if (error.code in mensagens) return mensagens[error.code]
  if (error.status === 429) return 'Muitas tentativas seguidas. Aguarde um minuto e tente de novo.'
  return 'Não foi possível concluir. Tente de novo em instantes.'
}

/** Depois deste erro o código atual não entra mais: só um código novo (a tela leva a pessoa a pedir outro). */
export const precisaDeCodigoNovo = (error: unknown) =>
  error instanceof AuthError && (error.code === 'TOO_MANY_ATTEMPTS' || error.code === 'OTP_EXPIRED')

export function resetWorkspaceContext() { configureDataMode(undefined) }
