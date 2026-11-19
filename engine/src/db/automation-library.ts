import type { Automation, Folder } from '../contracts'
import { listAutomations } from './automations'
import { REF_URL_WIDGET } from '../../../shared/trigger-types'
import { newRefCode } from './ref-links'
import { decode, nextKeywordPrioritySql, RepositoryError, requireRow, type Row } from './shared'
import { activeRunStatusSql } from '../flow/run-status'

export async function listFolders(db: D1Database, workspace: string) {
  const [folders, counts] = await Promise.all([
    db.prepare(`SELECT f.*, (SELECT count(*) FROM automations a WHERE a.workspace_id=f.workspace_id
      AND a.folder_id=f.id AND a.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM broadcasts b WHERE b.workspace_id=a.workspace_id AND b.automation_id=a.id)) AS count FROM folders f
      WHERE f.workspace_id=? ORDER BY lower(f.name),f.id`).bind(workspace).all<Row>(),
    db.prepare(`SELECT count(CASE WHEN deleted_at IS NULL THEN 1 END) AS total,
      count(CASE WHEN deleted_at IS NULL AND folder_id IS NULL THEN 1 END) AS unfiled,
      count(deleted_at) AS trashed FROM automations a WHERE workspace_id=? AND NOT EXISTS
      (SELECT 1 FROM broadcasts b WHERE b.workspace_id=a.workspace_id AND b.automation_id=a.id) AND a.id NOT LIKE 'api-content-%'`).bind(workspace).first<Row>(),
  ])
  return { folders: folders.results.map(row => decode<Folder & { count: number }>(row)), ...counts }
}

export async function saveFolder(db: D1Database, workspace: string,
  input: { name?: string; parent_id?: string | null }, id?: string) {
  if (id) requireRow(await db.prepare('SELECT id FROM folders WHERE workspace_id=? AND id=?').bind(workspace, id).first<Row>())
  if (input.parent_id) {
    requireRow(await db.prepare('SELECT id FROM folders WHERE workspace_id=? AND id=?').bind(workspace, input.parent_id).first<Row>())
    if (id) {
      const cycle = await db.prepare(`WITH RECURSIVE descendants(id) AS (
        SELECT id FROM folders WHERE workspace_id=? AND id=? UNION
        SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id WHERE f.workspace_id=?)
        SELECT id FROM descendants WHERE id=?`).bind(workspace, id, workspace, input.parent_id).first()
      if (cycle) throw new RepositoryError('Uma pasta não pode ficar dentro dela mesma ou de uma subpasta.', 409)
    }
  }
  const row = id
    ? await db.prepare(`UPDATE folders SET name=coalesce(?,name),parent_id=CASE WHEN ? THEN ? ELSE parent_id END,updated_at=?
      WHERE workspace_id=? AND id=? RETURNING *`).bind(input.name ?? null, Number(input.parent_id !== undefined), input.parent_id ?? null, Date.now(), workspace, id).first<Row>()
    : await db.prepare('INSERT INTO folders(id,workspace_id,name,parent_id) VALUES (?,?,?,?) RETURNING *')
      .bind(crypto.randomUUID(), workspace, input.name!, input.parent_id ?? null).first<Row>()
  return decode<Folder>(requireRow(row))
}

/** `moveItems`: as automações (até as da lixeira) vão para Sem pasta e as subpastas sobem para o nível da pasta excluída. */
export async function deleteFolder(db: D1Database, workspace: string, id: string, moveItems = false) {
  const folder = requireRow(await db.prepare('SELECT id,parent_id FROM folders WHERE workspace_id=? AND id=?').bind(workspace, id).first<Row>())
  const remove = db.prepare(`DELETE FROM folders WHERE workspace_id=? AND id=?
    AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.workspace_id=? AND f.parent_id=?)
    AND NOT EXISTS (SELECT 1 FROM automations a WHERE a.workspace_id=? AND a.folder_id=?) RETURNING id`)
    .bind(workspace, id, workspace, id, workspace, id)
  if (moveItems) {
    const [, , result] = await db.batch([
      db.prepare('UPDATE folders SET parent_id=?,updated_at=? WHERE workspace_id=? AND parent_id=?').bind(folder.parent_id ?? null, Date.now(), workspace, id),
      db.prepare('UPDATE automations SET folder_id=NULL WHERE workspace_id=? AND folder_id=?').bind(workspace, id),
      remove,
    ])
    if (!result.results.length) throw new RepositoryError('Não foi possível excluir a pasta. Tente de novo.', 409)
    return { ok: true as const }
  }
  const result = await remove.first()
  if (!result) throw new RepositoryError('A pasta ainda tem subpastas ou automações (as da Lixeira também contam). Mova esses itens antes, ou use “Mover itens para Sem pasta e excluir”.', 409)
  return { ok: true as const }
}

type LibraryOptions = Omit<NonNullable<Parameters<typeof listAutomations>[2]>, 'cursor' | 'limit'> & { cursor?: string }
export async function listAutomationLibrary(db: D1Database, workspace: string, opts: LibraryOptions) {
  let cursor: { time: number; id: string } | undefined
  if (opts.cursor) {
    try {
      const value = JSON.parse(atob(opts.cursor)) as { workspace?: unknown; time?: unknown; id?: unknown }
      if (value.workspace !== workspace || typeof value.time !== 'number' || !Number.isSafeInteger(value.time)
        || typeof value.id !== 'string' || !value.id.length || value.id.length > 128) throw new Error()
      cursor = { time: value.time, id: value.id }
    } catch { throw new RepositoryError('Cursor inválido.', 400) }
  }
  const rows = await listAutomations(db, workspace, { ...opts, cursor, limit: 31 })
  const items = rows.slice(0, 30)
  const last = items.at(-1)
  return { items, next_cursor: rows.length > 30 && last
    ? btoa(JSON.stringify({ workspace, time: Date.parse(last.updated_at), id: last.id })) : null }
}

export async function duplicateAutomation(db: D1Database, workspace: string, id: string) {
  const original = requireRow(await db.prepare('SELECT * FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL')
    .bind(workspace, id).first<Row>())
  const [triggers, keywords] = await Promise.all([
    db.prepare("SELECT * FROM triggers WHERE workspace_id=? AND automation_id=? AND status<>'disabled'").bind(workspace, id).all<Row>(),
    db.prepare(`SELECT k.* FROM keywords k JOIN triggers t ON t.workspace_id=k.workspace_id AND t.id=k.trigger_id
      WHERE k.workspace_id=? AND t.automation_id=? ORDER BY k.priority,t.created_at,t.id,k.id`).bind(workspace, id).all<Row>(),
  ])
  const triggerIds = new Map(triggers.results.map(row => [String(row.id), crypto.randomUUID()]))
  const keywordIds = new Map(keywords.results.map(row => [String(row.id), crypto.randomUUID()]))
  // Trigger nodes in the copied draft must edit their own trigger, never the source.
  const graph = JSON.parse(String(original.draft_graph), (key, value: unknown) =>
    key === 'trigger_id' && typeof value === 'string' ? triggerIds.get(value) ?? value : value) as unknown
  const copyId = crypto.randomUUID()
  const now = Date.now()
  const statements = [db.prepare(`INSERT INTO automations(id,workspace_id,name,folder_id,draft_graph,created_at,updated_at)
    SELECT ?,workspace_id,?,folder_id,?,?,? FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL`)
    .bind(copyId, `${original.name} (cópia)`, JSON.stringify(graph), now, now, workspace, id)]
  const triggerColumns = ['channel_id','name','kind','widget_type','repeat_mode','post_scope','target_post_id','first_level_only',
    'like_comment','public_replies','story_auto_like','delay_seconds','config','audience','group_match','group_thread_id']
  for (const row of triggers.results) {
    // O código do link de referência é único no canal: a cópia ganha o seu, o link já impresso continua sendo do original.
    const copy = row.kind === 'widget' && row.widget_type === REF_URL_WIDGET ? { ...row, config: JSON.stringify({ ...JSON.parse(String(row.config)), code: newRefCode() }) } : row
    statements.push(db.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,status,created_at,updated_at,${triggerColumns.join(',')})
      VALUES (?,?,?,'draft',?,?,${triggerColumns.map(() => '?').join(',')})`)
      .bind(triggerIds.get(String(row.id))!, workspace, copyId, now, now, ...triggerColumns.map(key => copy[key] ?? null)))
  }
  // Cópias de palavras de topo vão para o fim da lista do workspace (max+1, na ordem relativa original); filhos de grupo mantêm a ordem interna.
  for (const row of [...keywords.results.filter(r => !r.parent_id), ...keywords.results.filter(r => r.parent_id)]) {
    const top = !row.parent_id
    statements.push(db.prepare(`INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,case_sensitive,is_reserved,priority,created_at,updated_at)
      VALUES (?,?,?,?,?,'draft',?,?,${top ? nextKeywordPrioritySql : '?'},?,?)`).bind(keywordIds.get(String(row.id))!, workspace, triggerIds.get(String(row.trigger_id))!,
      row.rule, row.words, row.case_sensitive, row.is_reserved, top ? workspace : row.priority, now, now))
  }
  for (const row of keywords.results) if (row.parent_id) {
    statements.push(db.prepare('UPDATE keywords SET parent_id=? WHERE workspace_id=? AND id=?')
      .bind(keywordIds.get(String(row.parent_id))!, workspace, keywordIds.get(String(row.id))!))
  }
  await db.batch(statements)
  return decode<Automation>(requireRow(await db.prepare('SELECT * FROM automations WHERE workspace_id=? AND id=?').bind(workspace, copyId).first<Row>()))
}

export async function trashAutomation(db: D1Database, workspace: string, id: string) {
  requireRow(await db.prepare(`SELECT a.id FROM automations a WHERE a.workspace_id=? AND a.id=? AND a.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM broadcasts b WHERE b.workspace_id=a.workspace_id AND b.automation_id=a.id)`)
    .bind(workspace, id).first<Row>())
  const now = Date.now()
  const result = await db.batch([
    db.prepare(`UPDATE automations SET deleted_at=?,status=CASE WHEN published_version_id IS NULL THEN 'draft' ELSE 'stopped' END,updated_at=?
      WHERE workspace_id=? AND id=? AND deleted_at IS NULL RETURNING *`).bind(now, now, workspace, id),
    db.prepare(`UPDATE triggers SET status='inactive',updated_at=? WHERE workspace_id=? AND automation_id=?
      AND EXISTS (SELECT 1 FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NOT NULL)`).bind(now, workspace, id, workspace, id),
    db.prepare(`UPDATE flow_runs SET status='cancelled',wait_until=NULL,updated_at=? WHERE workspace_id=?
      AND status IN (${activeRunStatusSql}) AND automation_version_id IN
      (SELECT v.id FROM automation_versions v JOIN automations a ON a.workspace_id=v.workspace_id AND a.id=v.automation_id
        WHERE v.workspace_id=? AND v.automation_id=? AND a.deleted_at IS NOT NULL)`).bind(now, workspace, workspace, id),
    db.prepare(`UPDATE keywords SET status='draft',updated_at=? WHERE workspace_id=? AND trigger_id IN
      (SELECT t.id FROM triggers t JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
        WHERE t.workspace_id=? AND t.automation_id=? AND a.deleted_at IS NOT NULL)`).bind(now, workspace, workspace, id),
  ])
  return decode<Automation>(requireRow((result[0]!.results[0] as Row | undefined) ?? null))
}

export async function restoreAutomation(db: D1Database, workspace: string, id: string) {
  const row = await db.prepare(`UPDATE automations SET deleted_at=NULL,updated_at=?
    WHERE workspace_id=? AND id=? AND deleted_at IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM broadcasts b WHERE b.workspace_id=automations.workspace_id AND b.automation_id=automations.id) RETURNING *`).bind(Date.now(), workspace, id).first<Row>()
  return decode<Automation>(requireRow(row))
}

export async function permanentlyDeleteAutomation(db: D1Database, workspace: string, id: string) {
  const row = requireRow(await db.prepare('SELECT deleted_at FROM automations a WHERE workspace_id=? AND id=? AND NOT EXISTS (SELECT 1 FROM broadcasts b WHERE b.workspace_id=a.workspace_id AND b.automation_id=a.id)').bind(workspace, id).first<Row>())
  if (row.deleted_at === null) throw new RepositoryError('Envie a automação à lixeira antes de excluir de vez.', 409)
  const used = await db.prepare(`SELECT 1 WHERE
    EXISTS (SELECT 1 FROM rules WHERE workspace_id=? AND automation_id=?)
    OR EXISTS (SELECT 1 FROM sequence_steps WHERE workspace_id=? AND automation_id=?)
    OR EXISTS (SELECT 1 FROM broadcasts WHERE workspace_id=? AND automation_id=?)
    OR EXISTS (SELECT 1 FROM automations a,json_tree(a.draft_graph) node
      WHERE a.workspace_id=? AND a.id<>? AND node.key='automation_id' AND node.value=?)
    OR EXISTS (SELECT 1 FROM automations a JOIN automation_versions v ON v.workspace_id=a.workspace_id AND v.id=a.published_version_id,
      json_tree(v.graph) node WHERE a.workspace_id=? AND a.id<>? AND node.key='automation_id' AND node.value=?)
    OR EXISTS (SELECT 1 FROM flow_runs r JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id
      WHERE v.workspace_id=? AND v.automation_id=? AND r.status IN (${activeRunStatusSql}))`)
    .bind(workspace, id, workspace, id, workspace, id, workspace, id, id, workspace, id, id, workspace, id).first()
  if (used) throw new RepositoryError('Esta automação tem execuções ou vínculos. Remova-os antes de excluir de vez.', 409)
  await db.prepare('DELETE FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NOT NULL').bind(workspace, id).run()
  return { ok: true as const }
}
