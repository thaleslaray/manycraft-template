import { HTTPException } from 'hono/http-exception'
import type { IntegrationEnv } from '../../integrations'
import { STORY_REPLY_WIDGET } from '../../db/automations'
import { connectionRuntime } from './runtime'

/** A story trigger is published only on a connection that is connected and whose effective profile declares what the trigger asks for. */
export async function assertStoryPublishable(env: IntegrationEnv, ws: string, automation: string) {
  const triggers = await env.DB.prepare(`SELECT kind,channel_id,story_auto_like,post_scope FROM triggers WHERE workspace_id=? AND automation_id=?
    AND ((kind='widget' AND widget_type='${STORY_REPLY_WIDGET}') OR kind='story_mention_reply')`).bind(ws, automation)
    .all<{ kind: string; channel_id: string | null; story_auto_like: number; post_scope: string | null }>()
  for (const t of triggers.results) {
    const refuse = (reason: string): never => { throw new HTTPException(409, { message: `Não dá para publicar: ${reason}` }) }
    if (!t.channel_id) refuse('escolha uma conexão para o gatilho de story.')
    const rt = await connectionRuntime(env, ws, t.channel_id!, { secrets: false, requireConnected: true })
    if (rt.connection.status !== 'connected') refuse('confirme o webhook da conexão antes de publicar.')
    const stories = rt.connection.profile.stories
    if (t.kind === 'story_mention_reply' ? !stories?.mention : !stories?.reply || !rt.connection.profile.inbound.storyReply) refuse('a conexão não recebe esta entrada de story.')
    if (t.story_auto_like && !stories?.heart) refuse('a conexão não envia a reação de coração configurada.')
  }
}
