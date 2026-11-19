import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { HTTPException } from 'hono/http-exception'
import { authorize } from './permissions'
import { ACCOUNT_PHOTO_MAX_BYTES, ACCOUNT_PHOTO_TYPES } from './account-photo'

/** Configurações > Geral: nome, fuso e preferências de exibição do espaço. */
export const workspaceSettings = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

type Row = { name: string; timezone: string; show_only_subscribed: number; hide_keywords_tab: number; hide_rules_tab: number; import_enabled: number; profile_answers: string | null; photo_media_id: string | null; description: string | null }
const view = (row: Row) => ({ name: row.name, timezone: row.timezone, show_only_subscribed: row.show_only_subscribed === 1,
  hide_keywords_tab: row.hide_keywords_tab === 1, hide_rules_tab: row.hide_rules_tab === 1, import_enabled: row.import_enabled === 1,
  profile_answers: row.profile_answers ? JSON.parse(row.profile_answers) as Record<string, string> : null,
  photo_url: row.photo_media_id ? `/api/workspace-settings/photo/${row.photo_media_id}` : null, description: row.description })
const read = (db: D1Database, ws: string) => db.prepare('SELECT name,timezone,show_only_subscribed,hide_keywords_tab,hide_rules_tab,import_enabled,profile_answers,photo_media_id,description FROM workspaces WHERE id=?').bind(ws).first<Row>()

const timezone = z.string().min(1).max(64).refine(zone => { try { new Intl.DateTimeFormat('pt-BR', { timeZone: zone }).format(); return true } catch { return false } }, 'Fuso horário inválido.')
export const workspaceSettingsPatchSchema = z.object({ name: z.string().trim().min(1).max(120), timezone, show_only_subscribed: z.boolean(),
  hide_keywords_tab: z.boolean(), hide_rules_tab: z.boolean(),
  photo_media_id: z.string().uuid().nullable(), description: z.string().trim().max(280).nullable().transform(v => v || null) }).partial().strict()

workspaceSettings.get('/workspace-settings', async c => {
  authorize(c.var.principal, 'read')
  return c.json(view((await read(c.env.DB, c.var.principal.workspaceId))!))
})
workspaceSettings.patch('/workspace-settings', async c => {
  authorize(c.var.principal, 'team')
  let raw: unknown
  try { raw = await c.req.json() } catch { return c.json({ error: 'JSON inválido.' }, 400) }
  const input = workspaceSettingsPatchSchema.parse(raw)
  const workspaceId = c.var.principal.workspaceId
  if (input.photo_media_id) {
    // Mesma regra do envio (media.ts, purpose=account_photo): PNG, JPG ou WebP de até 2 MB.
    const file = await c.env.DB.prepare('SELECT content_type,size FROM media_objects WHERE workspace_id=? AND id=? AND bucket=\'media\'').bind(workspaceId, input.photo_media_id).first<{ content_type: string; size: number }>()
    if (!file || !ACCOUNT_PHOTO_TYPES.includes(file.content_type) || file.size > ACCOUNT_PHOTO_MAX_BYTES) throw new HTTPException(409, { message: 'A foto não está disponível neste espaço.' })
  }
  const antiga = 'photo_media_id' in input ? await c.env.DB.prepare('SELECT photo_media_id FROM workspaces WHERE id=?').bind(workspaceId).first<{ photo_media_id: string | null }>() : null
  const sets = Object.entries(input).map(([key]) => `${key}=?`)
  if (sets.length) {
    await c.env.DB.prepare(`UPDATE workspaces SET ${sets.join(',')},updated_at=? WHERE id=?`)
      .bind(...Object.values(input).map(v => typeof v === 'boolean' ? Number(v) : v), Date.now(), workspaceId).run()
  }
  // Trocar ou remover a foto apaga a mídia antiga (R2 e D1); a mesma foto de novo não apaga nada.
  if (antiga?.photo_media_id && antiga.photo_media_id !== input.photo_media_id) {
    const old = await c.env.DB.prepare('SELECT object_key FROM media_objects WHERE workspace_id=? AND id=?').bind(workspaceId, antiga.photo_media_id).first<{ object_key: string }>()
    if (old) {
      await c.env.MEDIA?.delete(old.object_key)
      await c.env.DB.prepare('DELETE FROM media_objects WHERE workspace_id=? AND id=?').bind(workspaceId, antiga.photo_media_id).run()
    }
  }
  return c.json(view((await read(c.env.DB, c.var.principal.workspaceId))!))
})

/** Questionário de perfil: segmento, tamanho, canal principal e objetivo. Responde uma vez; pular grava vazio. */
export const workspaceProfileSchema = z.object({ segment: z.string().max(60).optional(), size: z.string().max(30).optional(), channel: z.string().max(30).optional(), goal: z.enum(['leads', 'sales', 'support', 'engagement', 'skip']) }).strict()
workspaceSettings.put('/workspace-settings/profile', async c => {
  authorize(c.var.principal, 'team')
  const input = workspaceProfileSchema.parse(await c.req.json().catch(() => ({})))
  await c.env.DB.prepare('UPDATE workspaces SET profile_answers=?,updated_at=? WHERE id=?').bind(JSON.stringify(input), Date.now(), c.var.principal.workspaceId).run()
  return c.json(view((await read(c.env.DB, c.var.principal.workspaceId))!))
})

/** A foto da conta; o <img> não manda cabeçalho, então o espaço vem na query (ver workspaceFor no index). */
workspaceSettings.get('/workspace-settings/photo/:id', async c => {
  authorize(c.var.principal, 'read')
  const row = await c.env.DB.prepare('SELECT m.object_key,m.content_type FROM workspaces w JOIN media_objects m ON m.id=w.photo_media_id AND m.workspace_id=w.id WHERE w.id=? AND w.photo_media_id=?')
    .bind(c.var.principal.workspaceId, c.req.param('id')).first<{ object_key: string; content_type: string }>()
  const object = row && await c.env.MEDIA?.get(row.object_key)
  if (!row || !object) throw new HTTPException(404)
  return new Response(object.body, { headers: { 'Content-Type': row.content_type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, max-age=300' } })
})
