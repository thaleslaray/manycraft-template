import { z } from 'zod'
import { assertWorkspace, decode, RepositoryError, requireRow, type Row } from './shared'

export const settingsName = z.string().trim().min(1).max(128)
export const settingsKind = z.enum(['fields', 'tags'])
export type SettingsKind = z.infer<typeof settingsKind>
export type SettingsFolder = { id: string; workspace_id: string; kind: SettingsKind; name: string; created_at: string }

export async function assertSettingsFolder(db: D1Database, workspace: string, kind: SettingsKind, id?: string | null) {
  if (id != null && !await db.prepare('SELECT id FROM settings_folders WHERE workspace_id=? AND kind=? AND id=?').bind(workspace, kind, id).first()) {
    throw new RepositoryError('Pasta não encontrada nesta área do workspace.', 400)
  }
}
export async function assertSettingsName(db: D1Database, workspace: string, kind: SettingsKind, name: string, id = '', scope?: string) {
  const table = kind === 'fields' ? 'custom_fields' : 'tags'
  const duplicate = await db.prepare(`SELECT id FROM ${table} WHERE workspace_id=? AND name=? AND id<>?${kind === 'fields' ? ' AND scope=?' : ''}`)
    .bind(workspace, name, id, ...(kind === 'fields' ? [scope ?? 'contact'] : [])).first()
  if (duplicate) throw new RepositoryError('Já existe um item com esse nome.', 409)
}
export async function listSettingsFolders(db: D1Database, workspace: string, kind: SettingsKind) {
  assertWorkspace(workspace)
  const rows = await db.prepare('SELECT id,workspace_id,kind,name,created_at FROM settings_folders WHERE workspace_id=? AND kind=? ORDER BY name,id').bind(workspace, kind).all<Row>()
  return rows.results.map(row => decode<SettingsFolder>(row))
}
export async function saveSettingsFolder(db: D1Database, workspace: string, name: string, kind?: SettingsKind, id?: string) {
  assertWorkspace(workspace)
  name = settingsName.parse(name)
  if (id) kind = requireRow(await db.prepare('SELECT kind FROM settings_folders WHERE workspace_id=? AND id=?').bind(workspace, id).first<{ kind: SettingsKind }>()).kind
  if (!kind) throw new RepositoryError('Área da pasta obrigatória.', 400)
  if (await db.prepare('SELECT id FROM settings_folders WHERE workspace_id=? AND kind=? AND name=? AND id<>?').bind(workspace, kind, name, id ?? '').first()) {
    throw new RepositoryError('Já existe uma pasta com esse nome.', 409)
  }
  const now = Date.now()
  const row = id
    ? await db.prepare('UPDATE settings_folders SET name=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING id,workspace_id,kind,name,created_at').bind(name, now, workspace, id).first<Row>()
    : await db.prepare('INSERT INTO settings_folders(id,workspace_id,kind,name,created_at,updated_at) VALUES (?,?,?,?,?,?) RETURNING id,workspace_id,kind,name,created_at').bind(crypto.randomUUID(), workspace, kind, name, now, now).first<Row>()
  return decode<SettingsFolder>(requireRow(row))
}
export async function deleteSettingsFolder(db: D1Database, workspace: string, id: string) {
  assertWorkspace(workspace)
  requireRow(await db.prepare('DELETE FROM settings_folders WHERE workspace_id=? AND id=? RETURNING id').bind(workspace, id).first())
  return { ok: true as const }
}
