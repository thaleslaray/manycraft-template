/** Transporte compartilhado. O contexto real sempre vem do engine, nunca da URL da tela. */
import type { Role } from "../../../shared/permissions"
import { forgetAsync } from "../hooks/use-async"
import { staleAfterWrite } from "./screen-keys"

/** `role` vem da sessão; servidor antigo sem o campo conta como dono (o motor recusa de qualquer jeito). */
export type DevWorkspace = { workspace_id: string; name: string; role?: Role; user_name?: string }

let modeOverride: "real" | "fake" | undefined
let workspaceRequest: Promise<DevWorkspace> | undefined

/** Os testes Node não passam pelo Vite e continuam usando a base determinística. */
export function isFakeMode(): boolean {
  const env = (import.meta as ImportMeta & { env?: { VITE_DATA_MODE?: string } }).env
  return modeOverride ? modeOverride === "fake" : !env || env.VITE_DATA_MODE === "fake"
}

/** Override explícito para testes de contrato, sem afetar a configuração do bundle. */
export function configureDataMode(mode: "real" | "fake" | undefined): void {
  modeOverride = mode
  workspaceRequest = undefined
}

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

async function readResponse<T>(response: Response, allowNull = false): Promise<T> {
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : `Não foi possível concluir a operação (HTTP ${response.status}).`
    throw new ApiError(message, response.status)
  }
  if (response.status !== 204 && (body === undefined || (body === null && !allowNull))) throw new ApiError("O servidor retornou uma resposta inválida.", response.status)
  return body as T
}

export async function getWorkspace(): Promise<DevWorkspace> {
  if (isFakeMode()) return { workspace_id: "demo", name: "Demonstração" }
  workspaceRequest ??= (async () => {
    let workspace = await readResponse<DevWorkspace | null>(await fetch("/api/session/workspace", { cache: "no-store" }), true)
    if (workspace === null) {
      await readResponse(await fetch("/api/workspaces", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Meu espaço" }),
      }))
      workspace = await readResponse<DevWorkspace>(await fetch("/api/session/workspace", { cache: "no-store" }))
    }
    if (!workspace || typeof workspace.workspace_id !== "string" || !workspace.workspace_id || typeof workspace.name !== "string") {
      throw new Error("O servidor não informou o espaço de trabalho.")
    }
    return workspace
  })().catch(error => {
    workspaceRequest = undefined
    throw error
  })
  return workspaceRequest
}

/** GETs idênticos em voo: quem pede a mesma URL enquanto a primeira não respondeu compartilha a promessa. Nada fica depois de resolvido. */
const inflightGets = new Map<string, Promise<unknown>>()

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { workspace_id } = await getWorkspace()
  const url = `/api${path.startsWith("/") ? path : `/${path}`}`
  const shareable = (init.method ?? "GET").toUpperCase() === "GET" && !init.body && !init.signal
  const dedupeKey = shareable ? `${workspace_id} ${url} ${JSON.stringify(init.headers ?? null)}` : ""
  if (shareable) {
    const running = inflightGets.get(dedupeKey)
    if (running) return running as Promise<T>
  }
  const request = send<T>(url, workspace_id, init)
  // Gravação: o cache das telas que ela muda é descartado ao responder (mesmo com erro, ela pode ter valido em parte), antes de quem chamou recarregar.
  if (!shareable) return request.finally(() => { for (const prefix of staleAfterWrite(init.method ?? "GET", url.slice(4))) forgetAsync(prefix) })
  inflightGets.set(dedupeKey, request)
  const forget = () => { if (inflightGets.get(dedupeKey) === request) inflightGets.delete(dedupeKey) }
  request.then(forget, forget)
  return request
}

/**
 * Gravação feita com `fetch` direto (rotas sem cabeçalho de espaço: aceitar convite, pedir acesso): descarta os mesmos caches que o
 * apiRequest descartaria. Leituras sem espaço (prévia do convite, link compartilhado, CSV) não precisam.
 */
export function forgetAfterWrite(method: string, path: string): void {
  for (const prefix of staleAfterWrite(method, path)) forgetAsync(prefix)
}

async function send<T>(url: string, workspace_id: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set("x-workspace", workspace_id)
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  try {
    return await readResponse<T>(await fetch(url, {
      ...init, headers, cache: "no-store",
    }))
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      workspaceRequest = undefined
      if (typeof window !== 'undefined') window.location.replace('/login')
    }
    throw error
  }
}
