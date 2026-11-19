import { assertSettingsFolder, assertSettingsName, settingsName } from './settings-folders'
import type { Tag } from "../contracts"
import { assertWorkspace, decode, RepositoryError, requireRow, type Row } from "./shared"

const columns = "id, workspace_id, name, contact_count, archived, folder_id, created_at"

/** Contagem ao vivo: contato excluído sai da audiência, então não conta (mesma regra da lista de Contatos). */
const liveColumns = columns.replace("contact_count", `(SELECT count(*) FROM contact_tags ct JOIN contacts c ON c.workspace_id = ct.workspace_id AND c.id = ct.contact_id
  WHERE ct.workspace_id = tags.workspace_id AND ct.tag_id = tags.id AND c.status <> 'deleted') AS contact_count`)

export async function listTags(db: D1Database, workspaceId: string): Promise<Tag[]> {
  assertWorkspace(workspaceId)
  const result = await db.prepare(`SELECT ${liveColumns} FROM tags WHERE workspace_id = ? ORDER BY name, id`).bind(workspaceId).all<Row>()
  return result.results.map(row => decode<Tag>(row))
}

export async function getTag(db: D1Database, workspaceId: string, id: string): Promise<Tag | null> {
  assertWorkspace(workspaceId)
  const row = await db.prepare(`SELECT ${liveColumns} FROM tags WHERE workspace_id = ? AND id = ?`).bind(workspaceId, id).first<Row>()
  return row ? decode<Tag>(row) : null
}

export async function createTag(db: D1Database, workspaceId: string, name: string, folderId?: string | null): Promise<Tag> {
  assertWorkspace(workspaceId)
  name = settingsName.parse(name)
  await assertSettingsFolder(db, workspaceId, "tags", folderId)
  await assertSettingsName(db, workspaceId, "tags", name)
  const now = Date.now()
  const row = await db.prepare(`INSERT INTO tags (id, workspace_id, name, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING ${columns}`)
    .bind(crypto.randomUUID(), workspaceId, name, folderId ?? null, now, now).first<Row>()
  return decode<Tag>(requireRow(row))
}

export async function deleteTag(db: D1Database, workspaceId: string, id: string): Promise<{ ok: true }> {
  assertWorkspace(workspaceId)
  const result = await db.prepare("DELETE FROM tags WHERE workspace_id = ? AND id = ?").bind(workspaceId, id).run()
  if (!result.meta.changes) throw new RepositoryError()
  return { ok: true }
}

export async function tagContacts(db: D1Database, workspaceId: string, contactIds: string[], tagId: string,
  op: "add" | "remove" = "add", suppressRules = true): Promise<{ count: number }> {
  assertWorkspace(workspaceId)
  requireRow(await getTag(db, workspaceId, tagId))
  const ids = JSON.stringify([...new Set(contactIds)])
  const allowed = await db.prepare(`SELECT count(*) AS count FROM contacts WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))`)
    .bind(workspaceId, ids).first<{ count: number }>()
  if (allowed?.count !== new Set(contactIds).size) throw new RepositoryError()
  const mutation = op === "add"
    ? db.prepare(`INSERT INTO contact_tags (workspace_id, contact_id, tag_id) SELECT c.workspace_id, c.id, t.id
      FROM contacts c JOIN tags t ON t.workspace_id = c.workspace_id AND t.id = ? WHERE c.workspace_id = ?
      AND c.id IN (SELECT value FROM json_each(?)) ON CONFLICT (contact_id, tag_id) DO NOTHING RETURNING contact_id`)
      .bind(tagId, workspaceId, ids)
    : db.prepare(`DELETE FROM contact_tags WHERE workspace_id = ? AND tag_id = ? AND contact_id IN (SELECT value FROM json_each(?)) RETURNING contact_id`)
      .bind(workspaceId, tagId, ids)
  const result = suppressRules ? (await db.batch([
    db.prepare("INSERT INTO rule_event_suppressions(workspace_id,contact_id,type) SELECT ?,value,'tags' FROM json_each(?)").bind(workspaceId,ids),
    mutation,
    db.prepare("DELETE FROM rule_event_suppressions WHERE workspace_id=? AND type='tags' AND contact_id IN(SELECT value FROM json_each(?))").bind(workspaceId,ids),
  ]))[1] : await mutation.all()
  // D1 meta.changes also includes counter/timestamp triggers; RETURNING counts
  // only the associations requested by the caller.
  return { count: result.results.length }
}

export async function updateTag(db: D1Database, workspace: string, id: string, input: { name?: string; archived?: boolean; folder_id?: string | null }) {
  const tag = requireRow(await getTag(db, workspace, id)) as Tag & { archived: boolean; folder_id: string | null }
  const next = { ...tag, ...input }
  next.name = settingsName.parse(next.name)
  await assertSettingsFolder(db, workspace, 'tags', next.folder_id)
  await assertSettingsName(db, workspace, 'tags', next.name, id)
  const row = await db.prepare(`UPDATE tags SET name=?,archived=?,folder_id=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING ${columns}`)
    .bind(next.name, Number(next.archived), next.folder_id, Date.now(), workspace, id).first<Row>()
  return decode<Tag>(requireRow(row))
}
