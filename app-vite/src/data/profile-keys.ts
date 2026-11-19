import { apiRequest } from "./api"

export type ProfileKeyScope = "read" | "write"
export type ProfileKey = { id: string; name: string | null; scope: ProfileKeyScope | null; last4: string; created_at: number; last_used_at: number | null }

const DAY = 86_400_000
const STALE_DAYS = 90

/** "Só ler" ou "Ler e mudar"; chave antiga sem tipo lê e muda. */
export const scopeLabel = (scope: ProfileKeyScope | null | undefined) => scope === "read" ? "Só ler" : "Ler e mudar"

/** Aviso para chave parada há 90 dias ou mais (desde a criação, se nunca foi usada). */
export function staleWarning(key: Pick<ProfileKey, "created_at" | "last_used_at">, now = Date.now()): string | null {
  const days = Math.floor((now - (key.last_used_at ?? key.created_at)) / DAY)
  if (days < STALE_DAYS) return null
  return key.last_used_at == null
    ? `Nunca usada, criada há ${days} dias. Se não precisa mais dela, revogue.`
    : `Sem uso há ${days} dias. Se não precisa mais dela, revogue.`
}

/** De onde veio uma mudança do registro de atividade: painel (cookie) ou API (chave de perfil, com nome e final). */
export type ActivityVia = { via?: "api" | "painel" | null; api_key_name?: string | null; api_key_last4?: string | null }

/** Registro de atividade: "pela API (nome ••••1234)" quando a mudança veio por uma chave; nada quando veio do painel. */
export function viaLabel(row: ActivityVia): string | null {
  if (row.via !== "api") return null
  const parts = [row.api_key_name?.trim(), row.api_key_last4 ? `••••${row.api_key_last4}` : ""].filter(Boolean)
  return parts.length ? `pela API (${parts.join(" ")})` : "pela API"
}

export const listProfileKeys = () => apiRequest<{ items: ProfileKey[] }>("/profile/api-keys").then(r => r.items).catch(() => [] as ProfileKey[])
export const createProfileKey = (name: string, scope: ProfileKeyScope) =>
  apiRequest<ProfileKey & { token: string }>("/profile/api-key", { method: "POST", body: JSON.stringify({ name: name.trim(), scope }) })
export const revokeProfileKey = (id: string) => apiRequest(`/profile/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" })
