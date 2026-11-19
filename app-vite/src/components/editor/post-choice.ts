import type { TriggerConfig } from "@/data"

export type PostLike = { id: string; caption?: string; thumbnailUrl?: string; mediaUrl?: string; likes?: number; comments?: number }
export type PostChoice = { id: string; label: string; hint?: string; kind: "all" | "next" | "post"; post?: PostLike }

export const ALL_ID = "__all"
export const NEXT_ID = "__next"

/** Opções do pop-up de alvo do gatilho de comentário: todas, a próxima e cada publicação específica. */
export function buildPostChoices(posts: PostLike[], canPick: boolean): PostChoice[] {
  const all: PostChoice = { id: ALL_ID, label: "Todas as publicações ou Reels", kind: "all" }
  if (!canPick) return [all]
  return [all, { id: NEXT_ID, label: "A próxima publicação", kind: "next" },
    ...posts.map((post): PostChoice => ({ id: post.id, label: post.caption || `Publicação ${post.id}`, kind: "post", post }))]
}

/** Troca de alvo: sempre limpa o post anterior. */
export function postChoicePatch(choice: PostChoice): Partial<TriggerConfig> {
  if (choice.kind === "post") return { target: "specific", post_id: choice.id, post_snapshot: choice.post as TriggerConfig["post_snapshot"] }
  return { target: choice.kind, post_id: undefined, post_snapshot: undefined }
}

/** Nome do gatilho no nó do mapa. */
export function triggerNodeTitle(types: string[]): string {
  if (!types.length) return "Gatilho"
  if (new Set(types).size > 1) return "Gatilhos"
  const names: Record<string, string> = { ig_comment: "Comentário no post", ig_live_comment: "Comentário na live", ig_story_reply: "Resposta a story", ig_story_mention: "Menção em story", dm_keyword: "Palavra-chave", ref_url: "Link de referência", hotmart: "Compra na Hotmart", api: "Entrada externa (API)", ad: "Anúncio", cart_reply: "Carrinho do WhatsApp", ig_share_to_dm: "Compartilhamento no direct" }
  return names[types[0]] ?? "Gatilho"
}
