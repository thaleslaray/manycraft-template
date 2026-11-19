import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { boundedBody } from './security'
import { assertUnlocked, lockDenies } from './automation-actions'
import { clipboardSchema, collectRefs, parseShareLink, sharedToClipboard, translateClipboard, type FieldKind, type RefResolver } from './flow/manychat-import'
import type { ReportItem } from './flow/manychat-import/types'
import { createTriggers, devHashAllowed, DEV_HASH, fetchSharedFlow } from './manychat-share'
import { copyManychatMedia } from './manychat-media'
import { createTag } from './db/tags'
import { createField } from './db/fields'
import { listSequences, saveSequence } from './db/sequences'
import { validateGraph } from './schemas/graph'
import { decode, requireRow, type Row } from './db/shared'
import type { Automation } from './contracts'

/** Mapa opcional id da ManyChat -> nome, no formato do arquivo de referências da exportação. */
const namesSchema = z.object({
  tags: z.record(z.string(), z.object({ nome: z.string() }).passthrough()).optional(),
  campos: z.record(z.string(), z.object({ nome: z.string(), tipo: z.string().optional() }).passthrough()).optional(),
  sequencias: z.record(z.string(), z.object({ nome: z.string() }).passthrough()).optional(),
}).passthrough()
export const manychatImportSchema = z.object({
  clipboard: z.unknown(), original: z.unknown().optional(), names: namesSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(), folder_id: z.string().min(1).max(128).nullable().optional(),
}).strict()
export const manychatSharedImportSchema = z.object({
  share_url: z.string().trim().min(1).max(500),
  name: z.string().trim().min(1).max(120).optional(), folder_id: z.string().min(1).max(128).nullable().optional(),
}).strict()
const MAX_BODY = 4_000_000
const fieldKinds = new Set<string>(['text', 'number', 'date', 'datetime', 'boolean'])

export type ReferenceReport = { kind: 'tag' | 'field' | 'sequence'; manychat_id: string; id: string; name: string; created: boolean; missing_in_origin: boolean }
const clip = (name: string) => name.trim().slice(0, 120)

type ImportBody = z.infer<typeof manychatImportSchema>
type Ctx = Context<{ Bindings: Env; Variables: AuthVariables }>

export const manychatImport = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
manychatImport.post('/imports/manychat', async c => {
  authorize(c.var.principal, 'edit')
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder().decode(await boundedBody(c.req.raw, MAX_BODY))) } catch (error) {
    if (error instanceof HTTPException) throw error
    throw new HTTPException(400, { message: 'JSON inválido.' })
  }
  const body = manychatImportSchema.parse(raw)
  const out = await importFlow(c, body)
  return c.json(out.payload, out.status)
})

/** Colar blocos da ManyChat dentro de uma automação aberta: traduz (criando ou reaproveitando etiquetas e campos) e devolve
 * o pedaço de fluxo, sem criar nem alterar automação; o editor encaixa no rascunho e a pessoa salva. */
manychatImport.post('/imports/manychat/fragment', async c => {
  authorize(c.var.principal, 'edit')
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder().decode(await boundedBody(c.req.raw, MAX_BODY))) } catch (error) {
    if (error instanceof HTTPException) throw error
    throw new HTTPException(400, { message: 'JSON inválido.' })
  }
  const body = manychatImportSchema.parse(raw)
  const out = await importFlow(c, body, [], true)
  return c.json(out.payload, 200)
})

/** Importação pelo link compartilhado: o motor busca o fluxo na ManyChat, converte e segue o mesmo caminho da área de transferência. */
manychatImport.post('/imports/manychat/shared', async c => {
  authorize(c.var.principal, 'edit')
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder().decode(await boundedBody(c.req.raw, 16_000))) } catch (error) {
    if (error instanceof HTTPException) throw error
    throw new HTTPException(400, { message: 'JSON inválido.' })
  }
  const body = manychatSharedImportSchema.parse(raw)
  const hash = parseShareLink(body.share_url, devHashAllowed(c.env) ? DEV_HASH : undefined)
  if (!hash) throw new HTTPException(400, { message: 'Link inválido. Cole o link de compartilhamento da ManyChat (app.manychat.com).' })
  const db = c.env.DB, workspace = c.var.principal.workspaceId
  if (body.folder_id) requireRow(await db.prepare('SELECT id FROM folders WHERE workspace_id=? AND id=?').bind(workspace, body.folder_id).first<Row>())
  const shared = await fetchSharedFlow(c.env, hash)
  const converted = sharedToClipboard(shared)
  if (!converted.flow.shared) throw new HTTPException(404, { message: 'Este fluxo não está mais compartilhado na ManyChat.' })
  if (!converted.flow.cloning) throw new HTTPException(403, { message: 'O dono deste fluxo desativou a cópia na ManyChat; peça para ligar “Permitir cópia” no compartilhamento.' })
  if (!(converted.clipboard.data.nodesData as unknown[]).length) throw new HTTPException(422, { message: 'O fluxo compartilhado está vazio.' })
  const out = await importFlow(c, { clipboard: converted.clipboard, original: converted.original, names: converted.names, name: body.name, folder_id: body.folder_id }, converted.notes)
  const triggers = out.created ? await createTriggers(c, out.automationId, converted) : converted.triggers.map(t => ({ kind: t.kind, name: t.name, status: 'skipped' as const, reason: 'Reimportação: os gatilhos da automação existente não foram alterados.' }))
  return c.json({ ...out.payload, triggers, source: { name: converted.flow.name, ns: converted.flow.ns } }, out.status)
})

async function importFlow(c: Ctx, body: ImportBody, extraNotes: ReportItem[] = [], fragment = false) {
  clipboardSchema.parse(body.clipboard)
  const db = c.env.DB, workspace = c.var.principal.workspaceId
  if (body.folder_id) requireRow(await db.prepare('SELECT id FROM folders WHERE workspace_id=? AND id=?').bind(workspace, body.folder_id).first<Row>())

  const collected = collectRefs(body.clipboard)
  const references: ReferenceReport[] = []
  // Etiquetas e campos casam pelo nome; o que falta é criado. Sem nome no mapa: "Importado <id>" (referência apagada na origem).
  const tagIds = new Map<string, string>(), fieldIds = new Map<string, { id: string; type: FieldKind }>(), sequenceIds = new Map<string, string>()
  const existingTags = new Map((await db.prepare('SELECT id,name FROM tags WHERE workspace_id=?').bind(workspace).all<{ id: string; name: string }>()).results.map(r => [r.name, r.id]))
  for (const id of collected.tags) {
    const known = body.names?.tags?.[id]?.nome, name = clip(known ?? `Importado ${id}`)
    let found = existingTags.get(name), created = false
    if (!found) { found = (await createTag(db, workspace, name)).id; existingTags.set(name, found); created = true }
    tagIds.set(id, found)
    references.push({ kind: 'tag', manychat_id: id, id: found, name, created, missing_in_origin: !known })
  }
  const existingFields = new Map((await db.prepare("SELECT id,name,type FROM custom_fields WHERE workspace_id=? AND scope='contact'").bind(workspace).all<{ id: string; name: string; type: string }>()).results.map(r => [r.name, r]))
  for (const [id, inferred] of collected.fields) {
    const entry = body.names?.campos?.[id], name = clip(entry?.nome ?? `Importado ${id}`)
    const declared = entry?.tipo && fieldKinds.has(entry.tipo) ? entry.tipo as FieldKind : entry?.tipo === 'array' ? 'text' : inferred
    let found = existingFields.get(name), created = false
    if (!found) { const made = await createField(db, workspace, { name, type: declared }); found = { id: made.id, name, type: made.type }; existingFields.set(name, found); created = true }
    fieldIds.set(id, { id: found.id, type: fieldKinds.has(found.type) ? found.type as FieldKind : 'text' })
    references.push({ kind: 'field', manychat_id: id, id: found.id, name, created, missing_in_origin: !entry })
  }
  if (collected.sequences.size) {
    const existing = new Map((await listSequences(db, workspace)).map(s => [s.name, s.id]))
    for (const id of collected.sequences) {
      const known = body.names?.sequencias?.[id]?.nome, name = clip(known ?? `Importado ${id}`)
      let found = existing.get(name), created = false
      if (!found) { found = (await saveSequence(db, workspace, { name, steps: [] })).id; existing.set(name, found); created = true }
      sequenceIds.set(id, found)
      references.push({ kind: 'sequence', manychat_id: id, id: found, name, created, missing_in_origin: !known })
    }
  }
  const targets = new Map<string, string>()
  for (const ns of collected.automations) {
    const row = await db.prepare(`SELECT o.automation_id FROM manychat_flow_origins o JOIN automations a ON a.workspace_id=o.workspace_id AND a.id=o.automation_id
      WHERE o.workspace_id=? AND o.source_ns=? AND a.deleted_at IS NULL`).bind(workspace, ns).first<{ automation_id: string }>()
    if (row) targets.set(ns, row.automation_id)
  }
  const refs: RefResolver = {
    tag: id => tagIds.get(id) ?? `Importado ${id}`,
    field: id => fieldIds.get(id) ?? { id: `Importado ${id}`, type: 'text' },
    sequence: id => sequenceIds.get(id) ?? `Importado ${id}`,
    automation: ns => targets.get(ns) ?? null,
  }
  // Primeira passada só para descobrir a mídia da ManyChat; a segunda já aponta para as cópias (ou mantém o endereço e registra a pendência).
  const scan = translateClipboard(body.clipboard, { refs, original: body.original, name: body.name })
  // Reimportar sobre uma automação trancada reescreve o rascunho dela: a trava vale antes de qualquer cópia de mídia.
  const ns = fragment ? null : scan.report.source.ns
  const origin = ns ? await db.prepare(`SELECT o.automation_id FROM manychat_flow_origins o JOIN automations a ON a.workspace_id=o.workspace_id AND a.id=o.automation_id
    WHERE o.workspace_id=? AND o.source_ns=? AND a.deleted_at IS NULL`).bind(workspace, ns).first<{ automation_id: string }>() : null
  if (origin) await assertUnlocked(db, workspace, origin.automation_id, 'edit', c.var.principal)
  const copied = await copyManychatMedia(c.env, workspace, scan.report.media.map(m => m.url))
  const result = translateClipboard(body.clipboard, { refs, original: body.original, name: body.name, media: copied.resolver })
  const graph = validateGraph(result.graph)
  if (fragment) {
    return { automationId: '', created: false, status: 200 as const,
      payload: { graph, report: result.report, references, media: copied.outcomes } }
  }
  const now = Date.now()
  let automationId: string
  if (origin) {
    // Reimportar atualiza só o rascunho; o publicado, o nome e a pasta que a pessoa ajustou ficam como estão.
    automationId = origin.automation_id
    await db.batch([
      db.prepare('UPDATE automations SET draft_graph=?, has_unpublished_changes=published_version_id IS NOT NULL, updated_at=? WHERE workspace_id=? AND id=?').bind(JSON.stringify(graph), now, workspace, automationId),
      db.prepare('UPDATE manychat_flow_origins SET updated_at=?, page_id=? WHERE workspace_id=? AND source_ns=?').bind(now, result.report.source.page_id, workspace, ns),
    ])
  } else {
    automationId = crypto.randomUUID()
    const statements = [db.prepare('INSERT INTO automations(id,workspace_id,name,folder_id,draft_graph) VALUES (?,?,?,?,?)').bind(automationId, workspace, result.name, body.folder_id ?? null, JSON.stringify(graph))]
    if (ns) statements.push(db.prepare('INSERT INTO manychat_flow_origins(workspace_id,source_ns,automation_id,page_id) VALUES (?,?,?,?)').bind(workspace, ns, automationId, result.report.source.page_id))
    await db.batch(statements)
  }
  // Fluxos importados antes que apontavam para este (goto sem destino) passam a apontar para ele.
  let linked = 0
  if (ns) {
    const pending = await db.prepare(`SELECT a.id, a.draft_graph FROM manychat_flow_origins o JOIN automations a ON a.workspace_id=o.workspace_id AND a.id=o.automation_id
      WHERE o.workspace_id=? AND a.deleted_at IS NULL AND a.id<>? AND instr(a.draft_graph, ?)>0`).bind(workspace, automationId, `"source_flow_ns":${JSON.stringify(ns)}`).all<{ id: string; draft_graph: string }>()
    for (const row of pending.results) {
      if (await lockDenies(db, workspace, row.id, 'edit', c.var.principal)) continue   // automação trancada não é religada por quem não pode editá-la
      const other = JSON.parse(row.draft_graph) as { nodes: { type: string; config: Record<string, unknown> }[] }
      let changed = false
      for (const node of other.nodes) if (node.type === 'start_automation' && node.config.source_flow_ns === ns && !node.config.automation_id) { node.config.automation_id = automationId; changed = true; linked++ }
      if (changed) await db.prepare('UPDATE automations SET draft_graph=?, has_unpublished_changes=published_version_id IS NOT NULL, updated_at=? WHERE workspace_id=? AND id=?').bind(JSON.stringify(other), now, workspace, row.id).run()
    }
  }
  const automation = decode<Automation>(requireRow(await db.prepare('SELECT * FROM automations WHERE workspace_id=? AND id=?').bind(workspace, automationId).first<Row>()))
  if (extraNotes.length) {
    result.report.items.push(...extraNotes)
    for (const n of extraNotes) result.report.summary[n.level]++
  }
  return { automationId, created: !origin, status: (origin ? 200 : 201) as 200 | 201,
    payload: { automation, created: !origin, report: result.report, references, media: copied.outcomes, resolved_incoming_links: linked } }
}
