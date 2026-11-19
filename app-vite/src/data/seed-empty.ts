/**
 * Build de produção (modo de dados "api"): troca o `seed.ts` (dados inventados das telas de estudo) por listas vazias.
 * Só o modo fake (testes e demonstração) lê o seed; as constantes curtas ficam iguais.
 * A troca está no vite.config.ts (plugin "seed-so-no-fake").
 */
import type * as Seed from "./seed"

export const NOW = Date.parse("2026-10-23T12:00:00Z")
export const WS = "demo"
export const CH_IG = "ch-ig"
export const CH_TG = "ch-tg"
export const workspace: typeof Seed.workspace = { id: WS, name: "Demo", timezone: "America/Sao_Paulo", created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString() }
export const channels: typeof Seed.channels = []
export const tags: typeof Seed.tags = []
export const fields: typeof Seed.fields = []
export const folders: typeof Seed.folders = []
export const contacts: typeof Seed.contacts = []
export const contactChannels: typeof Seed.contactChannels = []
export const contactTags: typeof Seed.contactTags = []
export const fieldValues: typeof Seed.fieldValues = []
export const automations: typeof Seed.automations = []
export const automationVersions: typeof Seed.automationVersions = []
export const triggers: typeof Seed.triggers = []
export const nodeEvents: typeof Seed.nodeEvents = []
