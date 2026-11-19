// Endereços dos links de referência, no formato da documentação oficial da Meta:
//   WhatsApp   https://wa.me/<número>?text=<texto>          (texto pré-preenchido, até 140 caracteres)
//   Messenger  https://m.me/<página>?ref=<ref>               (developers.facebook.com/docs/messenger-platform/discovery/m-me-links)
//   Instagram  https://ig.me/m/<usuário>?ref=<ref>           (docs-meta-instagram, messaging-api/ig-me)

export type RefChannel = "whatsapp" | "messenger" | "instagram" | "telegram"

/** O texto pré-preenchido do WhatsApp (QR e link) vai até 140 caracteres (Meta, "QR Codes and Short Links", Limitations). */
export const PREFILL_MAX = 140

/** No WhatsApp o contato só existe quando envia a mensagem: o código vai no próprio texto, no fim. */
export function prefillText(text: string | undefined, code: string): string {
  return [text?.trim(), code].filter(Boolean).join(" ")
}

export function refLink(channel: RefChannel, handle: string, code: string, text?: string): string {
  if (channel === "whatsapp") return `https://wa.me/${handle}?text=${encodeURIComponent(prefillText(text, code))}`
  if (channel === "messenger") return `https://m.me/${handle}?ref=${encodeURIComponent(code)}`
  // Telegram: t.me/<bot>?start=<código> abre o bot e manda "/start <código>" (core.telegram.org/bots/features#deep-linking).
  if (channel === "telegram") return `https://t.me/${handle}?start=${encodeURIComponent(code)}`
  return `https://ig.me/m/${handle}?ref=${encodeURIComponent(code)}`
}
