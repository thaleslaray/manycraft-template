import { z } from 'zod'
import { assertSettingsFolder, assertSettingsName, settingsName } from './settings-folders'
import type { CustomField } from "../contracts"
import { assertWorkspace, decode, jsonValue, RepositoryError, requireRow, type Row } from "./shared"

export type Field = Omit<CustomField, "type"> & { type: CustomField["type"] | "array"; archived: boolean; folder_id: string | null }
export type FieldInput = Pick<Field, "name" | "type"> & Partial<Pick<Field, "scope" | "description" | "bot_value" | "folder_id">>
const columns = "id, workspace_id, scope, name, type, description, bot_value, archived, folder_id, created_at"

export async function listFields(db: D1Database, workspaceId: string): Promise<Field[]> {
  assertWorkspace(workspaceId)
  const result = await db.prepare(`SELECT ${columns} FROM custom_fields WHERE workspace_id = ? ORDER BY name, id`).bind(workspaceId).all<Row>()
  return result.results.map(row => decode<Field>(row))
}

export async function getField(db: D1Database, workspaceId: string, id: string): Promise<Field | null> {
  assertWorkspace(workspaceId)
  const row = await db.prepare(`SELECT ${columns} FROM custom_fields WHERE workspace_id = ? AND id = ?`).bind(workspaceId, id).first<Row>()
  return row ? decode<Field>(row) : null
}

export async function createField(db: D1Database, workspaceId: string, input: FieldInput): Promise<Field> {
  assertWorkspace(workspaceId)
  const name = settingsName.parse(input.name)
  await assertSettingsFolder(db, workspaceId, "fields", input.folder_id)
  await assertSettingsName(db, workspaceId, "fields", name, "", input.scope)
  const scope = input.scope ?? "contact"
  if (scope === "contact" && input.bot_value != null) throw new RepositoryError("Valor global exige campo do bot.", 400)
  if (input.bot_value != null) validateFieldValue(input.type, input.bot_value)
  const now = Date.now()
  const row = await db.prepare(`INSERT INTO custom_fields (id, workspace_id, scope, name, type, description, bot_value, folder_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${columns}`)
    .bind(crypto.randomUUID(), workspaceId, scope, name, input.type, input.description ?? null,
      input.bot_value == null ? null : jsonValue(input.bot_value), input.folder_id ?? null, now, now).first<Row>()
  return decode<Field>(requireRow(row))
}

export async function setFieldValue(db: D1Database, workspaceId: string, contactId: string, fieldId: string,
  value: unknown): Promise<{ ok: true }> {
  assertWorkspace(workspaceId)
  const field = requireRow(await getField(db, workspaceId, fieldId))
  if (field.scope !== "contact") throw new RepositoryError("Campo não pertence a um contato.", 400)
  if (value === null) {
    requireRow(await db.prepare("SELECT id FROM contacts WHERE workspace_id = ? AND id = ?").bind(workspaceId, contactId).first())
    await db.prepare("DELETE FROM contact_field_values WHERE workspace_id = ? AND contact_id = ? AND field_id = ?")
      .bind(workspaceId, contactId, fieldId).run()
    return { ok: true }
  }
  validateFieldValue(field.type, value)
  const result = await db.prepare(`INSERT INTO contact_field_values (workspace_id, contact_id, field_id, value, updated_at)
    SELECT c.workspace_id, c.id, f.id, ?, ? FROM contacts c JOIN custom_fields f
      ON f.workspace_id = c.workspace_id AND f.id = ? AND f.scope = 'contact'
    WHERE c.workspace_id = ? AND c.id = ?
    ON CONFLICT (contact_id, field_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE contact_field_values.workspace_id = excluded.workspace_id`)
    .bind(jsonValue(value), Date.now(), fieldId, workspaceId, contactId).run()
  if (!result.meta.changes) throw new RepositoryError()
  return { ok: true }
}

const fieldValueSchemas: Record<Field['type'], z.ZodType> = {
  text: z.string(), number: z.number(), boolean: z.boolean(), array: z.array(z.unknown()),
  date: z.iso.date(), datetime: z.iso.datetime({ offset: true }),
}
export function validateFieldValue(type: string, value: unknown) {
  if (!fieldValueSchemas[type as Field['type']]?.safeParse(value).success) {
    throw new RepositoryError(`Valor incompatível com o tipo ${type} do campo.`, 400)
  }
}
export type FieldPatch = Partial<Pick<Field, 'name' | 'description' | 'bot_value' | 'archived' | 'folder_id'>>
export async function updateField(db: D1Database, workspace: string, id: string, input: FieldPatch) {
  const field = requireRow(await getField(db, workspace, id))
  const next = { ...field, ...input }
  next.name = settingsName.parse(next.name)
  await assertSettingsFolder(db, workspace, 'fields', next.folder_id)
  await assertSettingsName(db, workspace, 'fields', next.name, id, field.scope)
  if (next.scope === 'contact' && next.bot_value != null) throw new RepositoryError('Valor global exige campo do bot.', 400)
  if (next.bot_value != null) validateFieldValue(field.type, next.bot_value)
  const row = await db.prepare(`UPDATE custom_fields SET name=?,description=?,bot_value=?,archived=?,folder_id=?,updated_at=?
    WHERE workspace_id=? AND id=? RETURNING ${columns}`)
    .bind(next.name, next.description, next.bot_value == null ? null : jsonValue(next.bot_value), Number(next.archived), next.folder_id, Date.now(), workspace, id).first<Row>()
  return decode<Field>(requireRow(row))
}
/** Inspect the actual immutable published snapshot, never the mutable draft. */
export async function fieldUsage(db: D1Database, workspace: string, id: string) {
  // Campo e automações publicadas saem juntos; campo inexistente continua dando 404 antes de qualquer resposta.
  const [field, rows] = await Promise.all([getField(db, workspace, id), db.prepare(`SELECT a.id,a.name,v.graph FROM automations a JOIN automation_versions v
    ON v.workspace_id=a.workspace_id AND v.id=a.published_version_id
    WHERE a.workspace_id=? AND a.deleted_at IS NULL ORDER BY a.name,a.id`)
    .bind(workspace).all<{ id: string; name: string; graph: string }>()])
  requireRow(field)
  const references = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(references)
    if (value && typeof value === 'object') {
      return Object.entries(value).some(([key, child]) =>
        (['field_id', 'custom_field_id', 'date_field_id'].includes(key) && child === id) || references(child))
    }
    return false
  }
  return rows.results.filter(row => references(JSON.parse(row.graph))).map(({ id, name }) => ({ id, name }))
}
export async function deleteField(db: D1Database, workspace: string, id: string) {
  assertWorkspace(workspace)
  requireRow(await db.prepare('DELETE FROM custom_fields WHERE workspace_id=? AND id=? RETURNING id').bind(workspace, id).first())
  return { ok: true as const }
}
