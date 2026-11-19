// Fonte única do tipo de gatilho: o banco guarda (kind, widget_type); a tela e os filtros falam TriggerType.
// O canal não mora aqui: vem da conexão do gatilho (triggers.channel_id -> channels.type).

export type TriggerType =
  | "ig_comment" | "ig_story_reply" | "ig_story_mention" | "ig_live_comment" | "ig_share_to_dm" | "dm_keyword"
  | "ref_url" | "welcome" | "default_reply" | "new_contact" | "api"
  | "ad" | "qr_code" | "cart_reply" | "another_flow" | "hotmart"

/** widget_type guardado -> tipo da tela. `messenger_ref_url` é o nome antigo do tipo único "link de referência" (vale para qualquer canal). */
export const WIDGET_TYPES: Record<string, TriggerType> = {
  feed_comment: "ig_comment", feed_comment_trigger: "ig_comment", instagram_story_reply: "ig_story_reply",
  instagram_share_to_story_reply: "ig_share_to_dm", instagram_live_comment_reply: "ig_live_comment",
  messenger_ref_url: "ref_url", ads: "ad", ctwa_trigger: "ad", tiktok_ads_ctx: "ad",
  messenger_code: "qr_code",
}
/** Valor guardado em widget_type para o link de referência de qualquer canal. */
export const REF_URL_WIDGET = "messenger_ref_url"

export const KIND_TYPES: Record<string, TriggerType> = {
  keyword: "dm_keyword", welcome_message: "welcome", default_reply: "default_reply", story_mention_reply: "ig_story_mention",
  external_trigger: "api",
  cart_reply: "cart_reply", another_flow: "another_flow",
}

export function triggerTypeOf(kind: string | null | undefined, widgetType: string | null | undefined): TriggerType {
  return (widgetType ? WIDGET_TYPES[widgetType] : undefined) ?? KIND_TYPES[String(kind)] ?? "api"
}

/** O mesmo mapeamento como CASE de SQL, para filtrar no banco sem repetir a tabela. */
export function triggerTypeSql(alias = "t"): string {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`
  const byType = (map: Record<string, TriggerType>) => {
    const groups = new Map<TriggerType, string[]>()
    for (const [key, type] of Object.entries(map)) groups.set(type, [...(groups.get(type) ?? []), key])
    return groups
  }
  const widgets = [...byType(WIDGET_TYPES)].map(([type, keys]) => `WHEN ${alias}.widget_type IN (${keys.map(quote).join(",")}) THEN ${quote(type)}`)
  const kinds = [...byType(KIND_TYPES)].map(([type, keys]) => `WHEN ${alias}.kind IN (${keys.map(quote).join(",")}) THEN ${quote(type)}`)
  return `CASE ${[...widgets, ...kinds].join(" ")} ELSE 'api' END`
}

export const triggerTypeLabel: Record<TriggerType, string> = {
  ig_comment: "Comentário", ig_story_reply: "Resposta a story", ig_story_mention: "Menção em story", ig_live_comment: "Comentário em live",
  ig_share_to_dm: "Compartilhamento em story", dm_keyword: "Palavra-chave", ref_url: "Link de referência",
  welcome: "Boas-vindas", default_reply: "Resposta padrão", new_contact: "Novo contato", api: "Entrada externa",
  ad: "Anúncio", qr_code: "Código QR", cart_reply: "Carrinho do WhatsApp", another_flow: "Outra automação",
  hotmart: "Hotmart",
}

/**
 * Código numérico do tipo de widget, o mesmo da ManyChat (importação, exportação e a coluna "Tipo" do painel).
 * Só os tipos de widget têm código; o canal continua separado (vem da conexão), então o mesmo código vale por canal.
 */
export const WIDGET_TYPE_CODES: Partial<Record<TriggerType, number>> = {
  ref_url: 8, ad: 9, qr_code: 11, ig_comment: 15, ig_story_reply: 19, ig_live_comment: 20,
}
/** Anúncio do Instagram tem código próprio (21); nos outros canais o anúncio é o 9. */
export function widgetTypeCode(type: TriggerType, channelType?: string | null): number | null {
  if (type === "ad" && channelType === "instagram") return 21
  return WIDGET_TYPE_CODES[type] ?? null
}
/** Identificador do tipo já com o canal ("ref_url:instagram"): o mesmo tipo em canais diferentes é outra coisa para filtros e contagens. */
export function typeChannelKey(type: TriggerType, channelType?: string | null): string {
  return channelType ? `${type}:${channelType}` : type
}

export const channelLabel: Record<string, string> = {
  instagram: "Instagram", messenger: "Messenger", whatsapp: "WhatsApp", telegram: "Telegram", tiktok: "TikTok", email: "E-mail",
}

/** "Tipo · Canal" (só o tipo quando o gatilho não tem conexão). */
export function typeAndChannel(type: TriggerType, channelType?: string | null): string {
  const label = triggerTypeLabel[type]
  return channelType ? `${label} · ${channelLabel[channelType] ?? channelType}` : label
}
