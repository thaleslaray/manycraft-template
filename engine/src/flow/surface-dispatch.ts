import type { InboundEvent } from '../integrations'
import type { InboundEvent as ChannelEvent } from '../channels/types'
import type { ConnectionRuntime } from '../channels/core/runtime'
import { upsertContact, hasConsent } from '../channels/core/identity'
import { syncInbound } from '../channels/core/inbound'
import { surfaceCapability, type SurfaceConfig, type SurfaceKind } from '../conversation-surfaces'
import { ensureConversation, isAutomationPaused, recordMessage } from '../inbox/service'
import { stableId, type FlowEnv } from './types'

/** Persistent entry payloads are scoped to a published configuration on this exact connection. */
export async function planSurfaceClick(env: FlowEnv, rt: ConnectionRuntime, event: InboundEvent, inboundId: string, click: Extract<ChannelEvent, { kind: 'click' }>) {
  const inbound = await env.DB.prepare('SELECT planned_at FROM inbound_events WHERE workspace_id=? AND id=?').bind(event.workspaceId, inboundId).first<{ planned_at: number | null }>()
  if (!inbound || inbound.planned_at !== null) return
  // Menu dinâmico do contato: o item leva o id da automação publicada a iniciar.
  if (click.payload?.startsWith('usermenu:')) {
    const automationId = click.payload.slice(9)
    const automation = await env.DB.prepare("SELECT published_version_id FROM automations WHERE workspace_id=? AND id=? AND status='live' AND deleted_at IS NULL")
      .bind(event.workspaceId, automationId).first<string>('published_version_id')
    const contact = await env.DB.prepare(`SELECT c.id FROM contacts c JOIN contact_channels cc ON cc.workspace_id=c.workspace_id AND cc.contact_id=c.id
      WHERE c.workspace_id=? AND cc.channel_id=? AND cc.external_user_id=? AND c.status='subscribed'`).bind(event.workspaceId, event.channelId, click.externalUserId).first<string>('id')
    if (automation && contact && !await isAutomationPaused(env, event.workspaceId, contact))
      await env.DB.prepare('INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,inbound_event_id,channel_id) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .bind(`usermenu-${await stableId(inboundId)}`, event.workspaceId, contact, automation, inboundId, event.channelId).run()
    await env.DB.prepare('UPDATE inbound_events SET planned_at=? WHERE workspace_id=? AND id=? AND planned_at IS NULL').bind(Date.now(), event.workspaceId, inboundId).run()
    return
  }
  const rows = await env.DB.prepare('SELECT kind,published FROM conversation_surfaces WHERE workspace_id=? AND connection_id=? AND published IS NOT NULL')
    .bind(event.workspaceId, event.channelId).all<{ kind: SurfaceKind; published: string }>()
  for (const row of rows.results) {
    if (!surfaceCapability(rt.connection.profile, row.kind)) continue
    const config: SurfaceConfig = JSON.parse(row.published)
    if (!config.enabled) continue
    const item = config.items.find(item => item.payload === click.payload)
    if (!item) continue
    const automation = await env.DB.prepare("SELECT published_version_id FROM automations WHERE workspace_id=? AND id=? AND status='live' AND deleted_at IS NULL")
      .bind(event.workspaceId, item.automation_id).first<{ published_version_id: string | null }>()
    if (!automation?.published_version_id) return
    const now = Date.now()
    // A deliberate entry click opens a direct conversation, including the very first interaction.
    const message: Extract<ChannelEvent, { kind: 'message' }> = { kind: 'message', externalUserId: click.externalUserId,
      externalMessageId: event.eventId, text: item.title, occurredAt: click.occurredAt }
    await syncInbound(env, rt, event, [message])
    await upsertContact(env, rt, event, inboundId, message, now)
    const contact = await env.DB.prepare(`SELECT c.id,c.status FROM contacts c JOIN contact_channels cc
      ON cc.workspace_id=c.workspace_id AND cc.contact_id=c.id WHERE c.workspace_id=? AND cc.channel_id=? AND cc.external_user_id=?`)
      .bind(event.workspaceId, event.channelId, click.externalUserId).first<{ id: string; status: string }>()
    if (!contact || contact.status !== 'subscribed' || !await hasConsent(env, event, message)
      || await isAutomationPaused(env, event.workspaceId, contact.id)) return
    const runId = `surface-${await stableId(inboundId)}`
    const conversationId = await ensureConversation(env, event.workspaceId, contact.id, event.channelId)
    await recordMessage(env, { id: `in-${await stableId(inboundId)}`, workspaceId: event.workspaceId, conversationId,
      direction: 'in', sender: 'contact', text: item.title, status: 'delivered', connectionId: event.channelId })
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,inbound_event_id,channel_id)
        SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM automations WHERE workspace_id=? AND id=? AND status='live' AND deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM conversation_surfaces s,json_each(s.published,'$.items') i
          WHERE s.workspace_id=? AND s.connection_id=? AND s.kind=? AND json_extract(s.published,'$.enabled')=1
          AND json_extract(i.value,'$.payload')=? AND json_extract(i.value,'$.automation_id')=?)
        ON CONFLICT(id) DO NOTHING`).bind(runId, event.workspaceId, contact.id, automation.published_version_id, inboundId, event.channelId,
          event.workspaceId, item.automation_id, event.workspaceId, event.channelId, row.kind, click.payload, item.automation_id),
      env.DB.prepare(`INSERT INTO surface_firings(workspace_id,connection_id,kind,item_id,inbound_id,run_id)
        SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM flow_runs WHERE workspace_id=? AND id=?)
        ON CONFLICT(workspace_id,inbound_id) DO NOTHING`).bind(event.workspaceId, event.channelId, row.kind, item.id, inboundId, runId, event.workspaceId, runId),
      env.DB.prepare('UPDATE inbound_events SET planned_at=? WHERE workspace_id=? AND id=? AND planned_at IS NULL').bind(now, event.workspaceId, inboundId),
    ])
    return
  }
}
