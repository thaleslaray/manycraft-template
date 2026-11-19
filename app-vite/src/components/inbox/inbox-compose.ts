import type { InboxConnectionProfile } from "@/data/inbox"

export type AttachmentKind = "image" | "file" | "audio" | "video"
export type AttachmentOption = { kind: AttachmentKind; label: string; accept: string; mime: string[]; maxBytes: number; limit: string }

/** "8 MB", "500 KB": the size a connection takes, as people say it. */
export function formatLimit(bytes: number): string {
  return bytes < 1_000_000 ? `${Math.round(bytes / 1000).toLocaleString("pt-BR")} KB` : `${(bytes / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`
}

const order: AttachmentKind[] = ["image", "file", "audio", "video"]
const labels: Record<AttachmentKind, string> = { image: "Imagem", file: "Arquivo", audio: "Áudio", video: "Vídeo" }

/** What the composer offers: only the kinds the conversation's connection takes (its capability sheet), with that sheet's size and type limits. */
export function attachmentOptions(profile: Pick<InboxConnectionProfile, "media"> | undefined): AttachmentOption[] {
  const media = profile?.media ?? {}
  return order.flatMap(kind => {
    const rule = media[kind]
    if (!rule?.maxBytes || !rule.mime.length) return []
    const label = kind === "file" && rule.mime.length === 1 && rule.mime[0] === "application/pdf" ? "PDF" : labels[kind]
    return [{ kind, label, accept: rule.mime.join(","), mime: rule.mime, maxBytes: rule.maxBytes, limit: `até ${formatLimit(rule.maxBytes)}` }]
  })
}

/** A refusal the person can act on, before anything is uploaded. */
export function attachmentError(option: AttachmentOption, file: { type: string; size: number }): string | undefined {
  if (!option.mime.includes(file.type)) return `Este canal não aceita esse tipo de arquivo para ${option.label.toLocaleLowerCase("pt-BR")}.`
  if (file.size > option.maxBytes) return `${option.label} ${option.limit}. Este arquivo tem ${formatLimit(file.size)}.`
}

const channelNames: Record<string, string> = { instagram: "Instagram", whatsapp: "WhatsApp", messenger: "Messenger", telegram: "Telegram" }
/** The send button names the channel the message leaves through. */
export function sendLabel(mode: "reply" | "note", channel: string | undefined): string {
  if (mode === "note") return "Salvar nota"
  if (channel === "email") return "Enviar por e-mail"
  return channel && channelNames[channel] ? `Enviar pelo ${channelNames[channel]}` : "Enviar resposta"
}

/** Puts text where the cursor is (replacing a selection) and says where the cursor goes next. */
export function insertAtCursor(text: string, start: number, end: number, insert: string): { text: string; cursor: number } {
  return { text: text.slice(0, start) + insert + text.slice(end), cursor: start + insert.length }
}

export const emojiGroups: { label: string; emojis: string[] }[] = [
  { label: "Rostos", emojis: ["😀", "😁", "😂", "🙂", "😉", "😊", "😍", "🤩", "😎", "🤔", "😅", "😢", "😭", "😡", "🙏", "🥳"] },
  { label: "Gestos", emojis: ["👍", "👎", "👏", "🙌", "👋", "🤝", "💪", "👌", "✌️", "🤞", "👀", "🔥"] },
  { label: "Símbolos", emojis: ["❤️", "💙", "💚", "⭐", "✨", "✅", "❌", "⚠️", "❓", "❗", "🎉", "🎁", "📌", "📎", "📞", "💬"] },
]
