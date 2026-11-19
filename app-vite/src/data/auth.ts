import { configureDataMode } from './api'

export type Session = { user: { emailVerified: boolean } } | null

export class AuthError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

export async function authRequest<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new AuthError(data?.code ?? 'REQUEST_FAILED', response.status)
  return data as T
}

export function authErrorMessage(error: unknown): string {
  if (!(error instanceof AuthError)) return 'Não foi possível conectar. Confira sua conexão e tente novamente.'
  if (error.status === 429) return 'Muitas tentativas. Aguarde um pouco e tente novamente.'
  if (error.code === 'SIGNUP_CLOSED') return 'O cadastro está fechado. Peça um convite a quem administra o espaço.'
  if (error.code === 'EMAIL_NOT_VERIFIED') return 'Confirme seu e-mail antes de entrar. Você pode pedir outro link de confirmação.'
  if (error.code === 'INVALID_EMAIL_OR_PASSWORD') return 'E-mail ou senha incorretos. Confira os dados e tente novamente.'
  if (['INVALID_TOKEN', 'TOKEN_EXPIRED'].includes(error.code)) return 'Link inválido ou expirado. Solicite um novo link para continuar.'
  if (['USER_ALREADY_EXISTS', 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'].includes(error.code)) return 'Não foi possível criar a conta. Tente entrar ou recuperar sua senha.'
  return 'Não foi possível concluir. Confira os dados e tente novamente.'
}

export function resetWorkspaceContext() { configureDataMode(undefined) }
export const authURL = (path: string) => new URL(path, window.location.origin).href
