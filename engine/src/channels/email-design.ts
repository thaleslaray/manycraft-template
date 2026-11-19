import { z } from 'zod'
import type { IntegrationEnv } from '../integrations'
import type { OutboundMessage, SendContext, SendResult } from './types'

const emailAction = z.object({ type: z.enum(['add_tag', 'remove_tag']), tag_id: z.string().min(1).max(128) })
const emailInteraction = z.object({ automationId: z.string().min(1).max(128).optional(), actions: z.array(emailAction).max(20).optional() })
const emailDesign = z.object({ text: z.string().max(100_000).optional(), subject: z.string().max(998).refine(value => !/[\r\n]/.test(value)), preheader: z.string().max(1000).optional(), html: z.string().optional(), senderId: z.string().optional(), onOpen: emailInteraction.extend({ mode: z.enum(['once', 'every']) }).optional(), linkActions: z.array(emailInteraction.extend({ url: z.url() })).max(100).optional() })
const snapshot = z.object({ nodes: z.array(z.object({ id: z.string(), config: z.record(z.string(), z.unknown()) })) })
/** The version on the run is immutable. Reading a draft here would silently change an already published automation. */
export async function emailMessageForRun(env: IntegrationEnv, ctx: SendContext, message: OutboundMessage): Promise<OutboundMessage | Extract<SendResult, { ok: false }>> {
  if (message.kind !== 'text' || message.email) return message
  let raw: unknown
  try { raw = JSON.parse(ctx.run.graph) } catch { return { ok: false, reason: 'rejected', code: 'invalid_email_snapshot', detail: 'O conteúdo publicado do e-mail está inválido.' } }
  // Broadcast delivery uses the generic facade with an empty graph, rather than a published automation.
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) {
    const prefix = 'broadcast-'
    if (ctx.run.automation_id?.startsWith(prefix)) return { ...message, email: { subject: '', source: {
      broadcastId: ctx.run.automation_id.slice(prefix.length), automationId: ctx.run.automation_id, nodeId: 'broadcast-message',
    } } }
    return message
  }
  const graph = snapshot.safeParse(raw)
  if (!graph.success) return { ok: false, reason: 'rejected', code: 'invalid_email_snapshot', detail: 'O conteúdo publicado do e-mail está inválido.' }
  const row = await env.DB.prepare('SELECT current_node_id FROM flow_runs WHERE workspace_id=? AND id=? AND contact_id=? AND channel_id=?')
    .bind(ctx.run.workspace_id, ctx.runId, ctx.run.contact_id, ctx.channelId).first<{ current_node_id: string | null }>()
  const node = graph.data.nodes.find(item => item.id === row?.current_node_id)
  if (!node?.config.email) return message
  const design = emailDesign.safeParse(node.config.email)
  if (!design.success) return { ok: false, reason: 'rejected', code: 'invalid_email_design', detail: 'Confira assunto e conteúdo no e-mail publicado.' }
  const { text: body, ...designFields } = design.data
  return { ...message, text: body ?? message.text, email: { ...designFields, source: { automationId: ctx.run.automation_id, nodeId: node.id } } }
}
