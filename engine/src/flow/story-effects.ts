import type { WorkflowStep } from 'cloudflare:workers'
import { connectionRuntime } from '../channels/core/runtime'
import { assertRunActive } from './state'
import { moveRun } from './run-state'
import type { StoryContext } from './story-dispatch'
import type { FlowEnv, Run } from './types'

/** Before the first block of a run born from a story mention: the heart reaction (immediately), then the trigger's pause.
 * The heart is best effort and is never retried: a failed or uncertain reaction is recorded and the conversation goes on. */
export async function runStoryPrelude(env: FlowEnv, step: WorkflowStep, run: Run): Promise<void> {
  const context = JSON.parse(run.story_context!) as StoryContext
  if (context.heart) await step.do('story-heart', async () => {
    await assertRunActive(env, run.id)
    let outcome: string
    try {
      const rt = await connectionRuntime(env, run.workspace_id, run.channel_id, { requireConnected: true })
      if (!rt.connection.profile.stories?.heart || !rt.provider?.react) outcome = 'unsupported'
      else {
        const result = await rt.provider.react({ connection: rt.connection, credentials: await rt.credentials(), fetch: rt.fetch, env,
          target: { kind: 'direct', externalUserId: context.externalUserId } }, { messageId: context.messageId, reaction: 'love' })
        outcome = result.ok ? 'sent' : result.reason
      }
    } catch { outcome = 'failed' }
    await env.DB.prepare("UPDATE flow_runs SET story_context=json_set(story_context,'$.heartResult',?) WHERE workspace_id=? AND id=?").bind(outcome, run.workspace_id, run.id).run()
    return outcome
  })
  if (context.delaySeconds > 0) {
    await step.do('story-delay-state', async () => {
      await assertRunActive(env, run.id)
      await moveRun(env.DB, run.id, 'waiting_delay', { waitReason: 'story_delay', waitUntil: Date.now() + context.delaySeconds * 1000 }).run()
    })
    await step.sleep('story-delay', context.delaySeconds * 1000)
  }
}
