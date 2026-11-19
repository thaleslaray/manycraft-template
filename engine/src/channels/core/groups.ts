import { stableId } from '../../flow/types'

/** Groups (F6, D15), provider independent. A group is a thread of its own: its messages never enter `conversations`, so a group never opens a
 * private conversation and never counts as a window or as consent for a direct message. Authors are ordinary contacts (the provider's sync makes them). */
type Db = { DB: D1Database }

export const threadIdOf = async (connectionId: string, externalGroupId: string) => `grp-${(await stableId(connectionId, externalGroupId)).slice(0, 40)}`

/** The thread of a group seen on a connection, created on first sight. A known subject is never replaced by an unknown one. */
export async function upsertGroupThread(env: Db, workspaceId: string, connectionId: string, externalGroupId: string, subject: string | null | undefined, at?: number): Promise<string> {
  const id = await threadIdOf(connectionId, externalGroupId)
  await env.DB.prepare(`INSERT INTO group_threads (workspace_id,id,channel_id,external_group_id,subject,last_message_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(channel_id,external_group_id) DO UPDATE SET subject=coalesce(excluded.subject,group_threads.subject),
      last_message_at=max(coalesce(group_threads.last_message_at,0),coalesce(excluded.last_message_at,0))`)
    .bind(workspaceId, id, connectionId, externalGroupId, subject ?? null, at ?? null).run()
  return id
}

export async function recordGroupMessage(env: Db, input: { workspaceId: string; threadId: string; direction: 'in' | 'out'; externalMessageId: string
  authorContactId?: string | null; mentionsMe?: boolean; text: string; at?: number; extra?: Record<string, unknown> }): Promise<void> {
  await env.DB.prepare(`INSERT INTO group_messages (workspace_id,id,group_thread_id,author_contact_id,direction,external_message_id,mentions_me,content,created_at)
    VALUES (?,?,?,?,?,?,?,?,coalesce(?,CAST(unixepoch('subsec') * 1000 AS INTEGER))) ON CONFLICT(group_thread_id,external_message_id) DO NOTHING`)
    .bind(input.workspaceId, `gm-${await stableId(input.threadId, input.direction, input.externalMessageId)}`, input.threadId, input.authorContactId ?? null,
      input.direction, input.externalMessageId, input.mentionsMe ? 1 : 0, JSON.stringify({ text: input.text, ...input.extra }), input.at ?? null).run()
}
