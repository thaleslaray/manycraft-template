import { integrationsHidden } from "../../lib/hidden-features"
import type { TriggerType } from "../../../../shared/trigger-types"

/** Canal da lista da esquerda no pop-up "Iniciar automação quando…". `kind` é o tipo de conexão que o gatilho exige (vazio: sem canal). */
export type TriggerChannel = { id: string; label: string; connectionKind?: string; blurb: string }
/** Cartão de gatilho. `kind` é o valor do formulário "Nova entrada da automação" (keyword-trigger-panel). */
export type TriggerCard = { kind: string; channel: string; kicker: string; title: string }

export const triggerChannels: TriggerChannel[] = [
  { id: "instagram", label: "Instagram", connectionKind: "instagram", blurb: "Evento específico do Instagram que inicia sua automação." },
  { id: "whatsapp", label: "WhatsApp", connectionKind: "whatsapp", blurb: "Evento específico do WhatsApp que inicia sua automação." },
  { id: "telegram", label: "Telegram", connectionKind: "telegram", blurb: "Evento específico do Telegram que inicia sua automação." },
  { id: "contact", label: "Eventos de contato", blurb: "Eventos externos que iniciam sua automação." },
  ...(integrationsHidden ? [] : [{ id: "hotmart" as const, label: "Eventos da Hotmart", blurb: "Eventos de compra da Hotmart que iniciam sua automação." }]),
]

export const triggerCards: TriggerCard[] = [
  { kind: "comment", channel: "instagram", kicker: "Comentários na publicação ou Reel", title: "O usuário deixa um comentário em sua publicação ou Reel" },
  { kind: "story_reply", channel: "instagram", kicker: "Resposta ao story", title: "O usuário responde ao seu Story" },
  { kind: "story_mention", channel: "instagram", kicker: "Menção no story", title: "O usuário menciona você em um Story" },
  { kind: "message", channel: "instagram", kicker: "Mensagem no Instagram", title: "O usuário envia uma mensagem" },
  { kind: "ad", channel: "instagram", kicker: "Anúncios no Instagram", title: "O usuário clica em um anúncio do Instagram" },
  { kind: "live_comment", channel: "instagram", kicker: "Comentários ao vivo", title: "O usuário deixa um comentário em sua transmissão ao vivo" },
  { kind: "ref_url", channel: "instagram", kicker: "URL de referência do Instagram", title: "O usuário clica em um link de referência" },
  { kind: "ig_share_to_dm", channel: "instagram", kicker: "Compartilhamento no direct", title: "O usuário compartilha um post ou reel no direct" },
  { kind: "message", channel: "whatsapp", kicker: "Mensagem no WhatsApp", title: "O usuário envia uma mensagem" },
  { kind: "ad", channel: "whatsapp", kicker: "Anúncios no WhatsApp", title: "O usuário clica em um anúncio que abre o WhatsApp" },
  { kind: "ref_url", channel: "whatsapp", kicker: "URL de referência do WhatsApp", title: "O usuário clica em um link de referência" },
  { kind: "cart_reply", channel: "whatsapp", kicker: "Carrinho do WhatsApp", title: "O usuário envia um carrinho" },
  { kind: "message", channel: "telegram", kicker: "Mensagem no Telegram", title: "O usuário envia uma mensagem" },
  { kind: "api", channel: "contact", kicker: "Entrada externa (API)", title: "Um sistema externo dispara a automação" },
  ...(integrationsHidden ? [] : [{ kind: "hotmart" as const, channel: "hotmart" as const, kicker: "Compras da Hotmart", title: "Uma compra é aprovada, completa ou abandonada" }]),
]

/** Título do painel de cada gatilho salvo (o nome que o original dá ao tipo). */
export const triggerPanelTitle: Partial<Record<TriggerType, string>> = {
  dm_keyword: "O usuário envia uma mensagem",
  ig_comment: "O usuário deixa um comentário em sua publicação ou Reel",
  ig_live_comment: "O usuário deixa um comentário em sua transmissão ao vivo",
  ig_story_reply: "O usuário responde ao seu Story",
  ig_story_mention: "O usuário menciona você em um Story",
  ref_url: "O usuário clica em um link de referência",
  ad: "O usuário clica em um anúncio",
  cart_reply: "O usuário envia um carrinho",
  ig_share_to_dm: "O usuário compartilha um post ou reel no direct",
  api: "Um sistema externo dispara a automação",
  hotmart: "Uma compra é aprovada, completa ou abandonada",
}
