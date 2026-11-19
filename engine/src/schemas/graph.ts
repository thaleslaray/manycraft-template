import { z } from "zod"


const id = z.string().min(1).max(128)
/** Shared, browser-safe contract. Link buttons cannot report a postback. */
export const buttonActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_tag'), tag_id: id }),
  z.object({ type: z.literal('remove_tag'), tag_id: id }),
  z.object({ type: z.literal('set_custom_field_value'), field_id: id, value: z.unknown() }).refine(a => Object.hasOwn(a, 'value'), 'Informe o valor do campo.'),
  z.object({ type: z.literal('unset_custom_field_value'), field_id: id }),
])
export type ButtonAction = z.infer<typeof buttonActionSchema>

export const durationSchema = z.object({
  value: z.number().int().positive(),
  unit: z.enum(["seconds", "minutes", "hours", "days"]),
}).passthrough()

const nodeTypes = [
  "default", "content", "email_new", "whatsapp", "instagram", "telegram", "tiktok",
  "action_group", "goto", "smart_delay", "condition", "multi_condition", "conditional", "split",
  "comment", "agent", "starting_step", "note", "main_menu", "form", "persistent_menu",
  // Vocabulary used by the current app-vite data contract.
  "trigger", "message", "question", "action", "randomizer", "start_automation", "dynamic", "template_message",
] as const
/** Node types the executor treats as a channel message (legacy per-channel names included). */
export const messageNodeTypes: string[] = ["message", "telegram", "content", "default"]
const blockTypes = [
  "text", "attachment", "cards", "card", "list", "list_item", "quick_reply", "telegram_keyboard",
  "question", "question_timeout", "delay", "dynamic", "otn_request", "template", "wa_list_message",
  "wa_catalog_message", "messenger_message_template", "case", "default", "variant", "email_root",
  "email_text", "email_image", "email_button", "email_divider", "email_trigger_open",
] as const
const answerTypes = [
  "free_text", "email", "phone", "multiple_choice", "number", "first_name", "last_name", "url", "file",
  "image", "location", "mc_location", "date", "datetime", "phone_for_sms",
] as const
const actionTypes = [
  "add_tag", "remove_tag", "set_custom_field_value", "unset_custom_field_value", "change_global_field_value",
  "fire_custom_event", "delete_subscriber", "send_lead_submitted_event", "trigger_a_zap", "add_to_sequence",
  "remove_from_sequence", "open_conversation", "close_conversation", "assign_conversation", "notify_admin",
  "start_flow", "subscribe_to_account", "unsubscribe_to_account", "global_unsubscribe_from_account",
  "external_request", "google_sheets", "active_campaign", "klaviyo", "mailchimp", "hubspot", "convertkit",
  "trigger_integromat", "flodesk", "custom_audience_user", "custom_audience_ig_user",
  "set_email_opt_in", "set_email_opt_out", "set_whatsapp_opt_in",
  "set_whatsapp_opt_out", "set_instagram_opt_in", "set_instagram_opt_out", "set_telegram_opt_in",
  "set_telegram_opt_out", "set_tiktok_opt_in", "set_tiktok_opt_out", "apps_request", "set_user_level_menu",
  "pause_automation_forever", "resume_automation", "send_event_to_capi", "pause_automations", "subscribe_topic", "unsubscribe_topic",
] as const

const nativeBlock = z.object({ type: z.enum(blockTypes) }).passthrough().superRefine((block, ctx) => {
  const check = (value: unknown, schema: z.ZodType, key: string) => {
    const result = schema.safeParse(value)
    if (!result.success) ctx.addIssue({ code: "custom", path: [key], message: `Valor inválido em ${key}.` })
  }
  if (block.type === "question") {
    if ("answer_timeout" in block) check(block.answer_timeout, durationSchema, "answer_timeout")
    if ("retries" in block) check(block.retries, z.number().int().nonnegative(), "retries")
    if ("answer_type" in block) check(block.answer_type, z.enum(answerTypes), "answer_type")
  }
  if (block.type === "quick_reply" && typeof block.settings === "object" && block.settings !== null && "timeout" in block.settings) {
    check(block.settings.timeout, durationSchema, "settings.timeout")
  }
})
export const mediaBlockSchema = z.object({ kind: z.literal("media"), media: z.enum(["image", "audio", "video", "file"]), url: z.string().max(4096), mediaId: z.string().min(1).optional(), mime: z.string().optional(), size: z.number().int().nonnegative().optional(), name: z.string().max(255).optional() }).passthrough()
export const quickReplyBlockSchema = z.object({ kind: z.literal("quick_reply"), id: z.string().min(1).max(64), label: z.string().max(4096), skip: z.boolean().optional() })
const listRowSchema = z.object({ id: z.string().min(1).max(64), title: z.string().max(4096), description: z.string().max(4096).optional() })
export const listBlockSchema = z.object({ kind: z.literal("list"), buttonText: z.string().max(4096), sections: z.array(z.object({ title: z.string().max(4096).optional(), rows: z.array(listRowSchema).max(100) })).max(100) })
export const typingBlockSchema = z.object({ kind: z.literal("typing"), seconds: z.number().min(1).max(10) })
export const buttonBlockSchema = z.object({ kind: z.literal("button"), id: z.string(), label: z.string(), actions: z.array(buttonActionSchema).max(5).optional(), action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("url"), url: z.string(), webview_size: z.enum(["full", "medium", "compact"]).optional() }), z.object({ type: z.literal("go_to_node") }),
    z.object({ type: z.literal("dynamic"), url: z.string() }), z.object({ type: z.literal("start_automation"), automation_id: z.string() }),
  ]) }).passthrough()
const cardDataSchema = z.object({ title: z.string().max(4096), subtitle: z.string().max(4096).optional(), imageUrl: z.string().max(4096).optional(), actionUrl: z.string().max(4096).optional(), buttons: z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('url'), title: z.string(), url: z.string() }),
  z.object({ type: z.literal('postback'), title: z.string(), id: z.string() }),
  z.object({ type: z.literal('call'), title: z.string(), phone: z.string() }),
])).max(3).optional() })
export const cardBlockSchema = z.object({ kind: z.literal('card'), aspectRatio: z.enum(['horizontal', 'square']), cards: z.array(cardDataSchema).max(1) })
export const galleryBlockSchema = z.object({ kind: z.literal('gallery'), aspectRatio: z.enum(['horizontal', 'square']), cards: z.array(cardDataSchema).max(10) })
const legacyBlock = z.discriminatedUnion("kind", [
  mediaBlockSchema, cardBlockSchema, galleryBlockSchema, quickReplyBlockSchema, listBlockSchema,
  z.object({ kind: z.literal("text"), text: z.string() }).passthrough(),
  z.object({ kind: z.literal("typing"), seconds: z.number().nonnegative() }).passthrough(),
  // A draft may contain an unfinished action; publication and runtime use buttonBlockSchema.
  buttonBlockSchema.extend({ actions: z.array(z.object({ type: z.enum(['add_tag', 'remove_tag', 'set_custom_field_value', 'unset_custom_field_value']) }).passthrough()).max(5).optional() }),
]).refine(block => !("type" in block), { message: "Blocos nativos devem usar o vocabulário de type." })

/** Notas adesivas e quadros do canvas: só organizam o desenho, o motor nunca os executa. */
export const annotationColors = ["yellow", "green", "pink", "blue", "purple"] as const
export const annotationLimits = { minW: 120, maxW: 2400, minH: 64, maxH: 2400, max: 200 } as const
export const annotationSchema = z.object({
  id: id.max(64),
  kind: z.enum(["note", "group", "portal"]),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  size: z.object({ w: z.number().finite().min(annotationLimits.minW).max(annotationLimits.maxW), h: z.number().finite().min(annotationLimits.minH).max(annotationLimits.maxH) }),
  color: z.enum(annotationColors),
  text: z.string().max(2000).optional(),
  title: z.string().max(120).optional(),
  font_size: z.enum(["sm", "md", "lg"]).optional(),
  author: z.string().max(120).optional(),
  font: z.enum(["sans", "serif", "mono"]).optional(),
  /** Portal: atalho visual que leva o mapa até outro passo desta automação (o motor ignora). */
  target: id.max(128).optional(),
})
export type Annotation = z.infer<typeof annotationSchema>

export const graphSchema = z.object({
  nodes: z.array(z.object({
    id: z.string().min(1), type: z.enum(nodeTypes),
    position: z.object({ x: z.number(), y: z.number() }),
    config: z.object({
      blocks: z.array(z.union([nativeBlock, legacyBlock])).optional(),
      actions: z.array(z.object({ type: z.enum(actionTypes) }).passthrough()).optional(),
    }).passthrough(),
  }).passthrough()),
  edges: z.array(z.object({ from: z.string(), port: z.string(), to: z.string() })),
  annotations: z.array(annotationSchema).max(annotationLimits.max).optional(),
}).passthrough().superRefine((graph, ctx) => {
  const ids = new Set<string>()
  for (const node of graph.nodes) {
    if (ids.has(node.id)) ctx.addIssue({ code: "custom", path: ["nodes"], message: "IDs de nós devem ser únicos." })
    ids.add(node.id)
  }
  const stepIds = new Set(ids)
  for (const note of graph.annotations ?? []) {
    if (ids.has(note.id)) ctx.addIssue({ code: "custom", path: ["annotations"], message: stepIds.has(note.id) ? "A nota ou o grupo não pode usar o ID de um passo." : "IDs de notas e grupos devem ser únicos." })
    ids.add(note.id)
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) ctx.addIssue({ code: "custom", path: ["edges"], message: "A conexão referencia um nó inexistente." })
  }
})

export function validateGraph(graph: unknown) {
  return graphSchema.parse(graph)
}

/** Reachability from all entries catches isolated cycles as well as nodes with no incoming edge. */
export function disconnectedSteps(graph: { nodes: { id: string; type: string }[]; edges: { from: string; to: string }[] }): string[] {
  const reached = new Set(graph.nodes.filter(n => ['trigger', 'starting_step'].includes(n.type)).map(n => n.id))
  if (!reached.size) return [] // A partial editor selection has no entry; publication checks the missing trigger separately.
  const queue = [...reached]
  for (let i = 0; i < queue.length; i++) {
    for (const edge of graph.edges.filter(e => e.from === queue[i])) {
      if (!reached.has(edge.to)) { reached.add(edge.to); queue.push(edge.to) }
    }
  }
  return graph.nodes.filter(n => !['note', 'comment'].includes(n.type) && !reached.has(n.id)).map(n => n.id)
}
