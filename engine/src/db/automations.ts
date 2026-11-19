import { triggerTypeOf, triggerTypeSql } from '../../../shared/trigger-types'
import { refLink, type RefChannel } from '../../../shared/ref-link'
import { isCards, cardTexts } from '../schemas/message-cards'
import { isManychatMediaUrl } from '../flow/manychat-import/media'
import { validateLogicReferences } from '../flow/conditions'
import { validateMessageVariables } from './message-variables'
import { questionFieldType, questionSchema, questionSystemField, questionSystemFieldFits } from '../schemas/question'
import type { Automation, AutomationDetail, AutomationRow, ChannelType, FlowPreview, Graph, AutomationVersion, Trigger, TriggerConfig, TriggerType } from "../contracts"
import { validateGraph, disconnectedSteps, buttonBlockSchema, quickReplyBlockSchema, typingBlockSchema } from "../schemas/graph"
import { actionSchema, validateActionReference } from '../schemas/actions'
import { validateFieldValue } from './fields'
import { assertWorkspace, decode, jsonValue, RepositoryError, requireRow, type Row } from "./shared"

/** Stored widget type of the story-reply trigger (graph vocabulary: the name is data, not a channel decision). */
export const STORY_REPLY_WIDGET = 'instagram_story_reply'
export const LIVE_COMMENT_WIDGET = 'instagram_live_comment_reply'
/** Gatilho de post/reel compartilhado no direct (Share to DM). */
export const SHARE_TO_DM_WIDGET = 'instagram_share_to_story_reply'

function trigger(row: Row): Trigger {
  const config = JSON.parse(String(row.config)) as Record<string, unknown>
  if (row.widget_type === 'messenger_ref_url' && typeof config.code !== 'string' && typeof config.ref === 'string') config.code = config.ref   // formato antigo: só o código
  // Link de referência: o endereço pronto sai do código, da conexão e do endereço guardados.
  if (row.widget_type === 'messenger_ref_url' && typeof config.code === 'string' && typeof config.handle === 'string' && ['whatsapp', 'messenger', 'instagram'].includes(String(row.channel_type)))
    config.link = refLink(row.channel_type as RefChannel, config.handle, config.code, typeof config.text === 'string' ? config.text : undefined)
  return {
    id: String(row.id), workspace_id: String(row.workspace_id), automation_id: String(row.automation_id),
    channel_id: row.channel_id as string | null, channel_type: (row.channel_type as ChannelType | null) ?? null, name: String(row.name),
    type: triggerTypeOf(row.kind as string, row.widget_type as string | null),
    config: { ...config, target: row.post_scope ?? config.target ?? "all", post_id: row.target_post_id ?? config.post_id,
      include: config.include ?? [], exclude: config.exclude ?? [], public_replies: JSON.parse(String(row.public_replies)),
    } as TriggerConfig,
    active: row.status === "active", created_at: new Date(Number(row.created_at)).toISOString(),
    updated_at: new Date(Number(row.updated_at)).toISOString(),
  }
}

function summarizeTrigger(row: Row): string {
  const t = trigger(row)
  const quote = (words: string[]) => words.map(word => `“${word}”`).join(", ")
  if (t.type === "ig_comment") {
    const where = t.config.target === "all" ? "em qualquer post" : t.config.target === "next" ? "no próximo post" : "em um post específico"
    return `Quando alguém comenta ${t.config.include.length ? `${quote(t.config.include)} ` : ""}${where}${t.config.exclude.length ? `, exceto ${quote(t.config.exclude)}` : ""}`
  }
  if (t.type === "dm_keyword") return `Quando chega uma mensagem${t.config.include.length ? ` com ${quote(t.config.include)}` : ""}${t.config.exclude.length ? `${t.config.include.length ? "," : ""} sem ${quote(t.config.exclude)}` : ""}`
  if (t.type === "ig_story_reply") {
    const words = (t.config as unknown as { words?: string[]; rule?: string }).words ?? []
    return `Quando alguém responde ${t.config.target === "specific" ? "a um story específico" : "a qualquer story"}${words.length ? ` ${(t.config as unknown as { rule?: string }).rule === "is" ? "com exatamente" : "com"} ${quote(words)}` : ""}`
  }
  if (t.type === "ref_url") return "Quando alguém chega pelo link de referência"
  if (t.type === "ig_story_mention") return "Quando alguém menciona você em um story"
  if (t.type === "welcome") return "Quando um contato novo manda a primeira mensagem"
  if (t.type === "default_reply") return "Quando nenhuma palavra-chave reconhece a mensagem"
  return t.name
}

export async function createAutomation(db: D1Database, workspaceId: string, input: { name: string; folder_id?: string | null }): Promise<Automation> {
  assertWorkspace(workspaceId)
  if (input.folder_id) requireRow(await db.prepare('SELECT id FROM folders WHERE workspace_id=? AND id=?')
    .bind(workspaceId, input.folder_id).first<Row>())
  const graph = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 80 }, config: {} }], edges: [] }
  const row = await db.prepare(`INSERT INTO automations (id,workspace_id,name,folder_id,draft_graph)
    VALUES (?,?,?,?,?) RETURNING *`).bind(crypto.randomUUID(), workspaceId, input.name, input.folder_id ?? null, jsonValue(graph)).first<Row>()
  return decode<Automation>(requireRow(row))
}

export async function updateAutomation(db: D1Database, workspaceId: string, id: string,
  patch: { name?: string; status?: 'live' | 'stopped'; folder_id?: string | null }): Promise<Automation> {
  assertWorkspace(workspaceId)
  if (patch.folder_id) requireRow(await db.prepare('SELECT id FROM folders WHERE workspace_id=? AND id=?')
    .bind(workspaceId, patch.folder_id).first<Row>())
  const row = await db.prepare(`UPDATE automations SET name=coalesce(?,name), status=coalesce(?,status),
    folder_id=CASE WHEN ? THEN ? ELSE folder_id END, updated_at=?
    WHERE workspace_id=? AND id=? AND deleted_at IS NULL AND (? IS NULL OR published_version_id IS NOT NULL) RETURNING *`)
    .bind(patch.name ?? null, patch.status ?? null, Number(patch.folder_id !== undefined), patch.folder_id ?? null, Date.now(), workspaceId, id, patch.status ?? null).first<Row>()
  if (!row) {
    requireRow(await getAutomation(db, workspaceId, id))
    throw new RepositoryError('Publique a automação antes de pausar ou retomar.', 409)
  }
  return decode<Automation>(row)
}

/** Resumo leve do mapa para a miniatura do cartão: só posição, tipo e ligações. Sem passos além do gatilho, nada a desenhar. */
function flowPreview(graph: Graph | null | undefined): FlowPreview | null {
  if (!graph?.nodes || graph.nodes.length < 2) return null
  return {
    nodes: graph.nodes.map(n => ({ id: n.id, type: n.type, x: n.position?.x ?? 0, y: n.position?.y ?? 0 })),
    edges: (graph.edges ?? []).map(e => ({ from: e.from, to: e.to })),
  }
}

export async function listAutomations(db: D1Database, workspaceId: string,
  opts: { folder_id?: string | null; status?: Automation["status"]; search?: string;
    trash?: boolean; cursor?: { time: number; id: string }; limit?: number; trigger_type?: TriggerType; trigger_status?: string } = {}): Promise<AutomationRow[]> {
  assertWorkspace(workspaceId)
  const where = ["a.workspace_id = ?", opts.trash ? "a.deleted_at IS NOT NULL" : "a.deleted_at IS NULL",
    "NOT EXISTS (SELECT 1 FROM broadcasts b WHERE b.workspace_id=a.workspace_id AND b.automation_id=a.id)", "a.id NOT LIKE 'api-content-%'"]
  const params: (string | number | null)[] = [workspaceId]
  if (opts.folder_id !== undefined) { where.push("a.folder_id IS ?"); params.push(opts.folder_id) }
  if (opts.status) { where.push("a.status = ?"); params.push(opts.status) }
  if (opts.search?.trim()) { where.push("instr(lower(a.name), lower(?)) > 0"); params.push(opts.search.trim()) }
  if (opts.cursor) { where.push('(a.updated_at < ? OR (a.updated_at = ? AND a.id < ?))'); params.push(opts.cursor.time, opts.cursor.time, opts.cursor.id) }
  if (opts.trigger_type || opts.trigger_status) {
    const conditions = ['t.workspace_id=a.workspace_id', 't.automation_id=a.id', "t.status<>'disabled'"]
    if (opts.trigger_type) {
      conditions.push(`${triggerTypeSql('t')} = ?`)
      params.push(opts.trigger_type)
    }
    if (opts.trigger_status) { conditions.push('t.status=?'); params.push(opts.trigger_status) }
    where.push(`EXISTS (SELECT 1 FROM triggers t WHERE ${conditions.join(' AND ')})`)
  }
  // Tudo numa ida só: gatilhos, palavras-chave e versões publicadas não esperam a lista, porque
  // filtram pelo mesmo conjunto de automações (subconsulta) em vez de por ids já lidos.
  const since = Date.now() - 30 * 86400_000, tail = opts.limit ? [opts.limit] : []
  const pageIds = `SELECT a.id FROM automations a WHERE ${where.join(" AND ")} ORDER BY a.updated_at DESC, a.id DESC ${opts.limit ? "LIMIT ?" : ""}`
  const inPage = opts.limit ? `AND automation_id IN (${pageIds})` : ''
  const [rows, triggers, keywords, versions] = await db.batch<Row>([
    db.prepare(`SELECT a.*,
    (SELECT count(*) FROM triggers t WHERE t.workspace_id = a.workspace_id AND t.automation_id = a.id AND t.status <> 'disabled') AS trigger_count,
    coalesce((SELECT t.name FROM triggers t WHERE t.workspace_id = a.workspace_id AND t.automation_id = a.id AND t.status <> 'disabled' ORDER BY t.created_at, t.id LIMIT 1), 'Sem gatilho') AS trigger_summary,
    (SELECT count(*) FROM flow_runs f JOIN automation_versions v ON v.workspace_id = f.workspace_id AND v.id = f.automation_version_id
      WHERE f.workspace_id = a.workspace_id AND v.automation_id = a.id AND f.created_at >= ?) AS runs,
    (SELECT 1.0 * sum(e.type = 'clicked') / nullif(sum(e.type = 'sent'), 0) FROM node_events e
      WHERE e.workspace_id = a.workspace_id AND e.automation_id = a.id AND e.created_at >= ?) AS ctr,
    (SELECT count(DISTINCT e.contact_id) FROM node_events e WHERE e.workspace_id=a.workspace_id AND e.automation_id=a.id AND e.type='delivered' AND e.created_at>=?) AS delivered,
    (SELECT count(DISTINCT e.contact_id) FROM node_events e WHERE e.workspace_id=a.workspace_id AND e.automation_id=a.id AND e.type='read' AND e.created_at>=?) AS read
    FROM automations a WHERE ${where.join(" AND ")} ORDER BY a.updated_at DESC, a.id DESC ${opts.limit ? "LIMIT ?" : ""}`)
      .bind(since, since, since, since, ...params, ...tail),
    db.prepare(`SELECT t.*, (SELECT c.type FROM channels c WHERE c.workspace_id=t.workspace_id AND c.id=t.channel_id) AS channel_type FROM triggers t WHERE t.workspace_id = ? AND t.status <> 'disabled' ${inPage} ORDER BY t.created_at, t.id`)
      .bind(workspaceId, ...(opts.limit ? [...params, ...tail] : [])),
    db.prepare(`SELECT trigger_id, rule, words FROM keywords WHERE workspace_id=? AND trigger_id IN
      (SELECT id FROM triggers WHERE workspace_id=? ${inPage})
      AND rule NOT IN ('group','any','thumbs_up') ORDER BY priority,id`)
      .bind(workspaceId, workspaceId, ...(opts.limit ? [...params, ...tail] : [])),
    db.prepare(`SELECT id, graph FROM automation_versions WHERE workspace_id=? AND id IN
      (SELECT a.published_version_id FROM automations a WHERE a.id IN (${pageIds}))`)
      .bind(workspaceId, ...params, ...tail),
  ]) as unknown as [D1Result<Row>, D1Result<Row>, D1Result<{ trigger_id: string; rule: string; words: string }>, D1Result<{ id: string; graph: string }>]
  if (!rows.results.length) return []
  const words = new Map<string, { include: string[]; exclude: string[] }>()
  for (const k of keywords.results) {
    const config = words.get(k.trigger_id) ?? { include: [], exclude: [] }
    config[k.rule === 'does_not_contain' ? 'exclude' : 'include'].push(...JSON.parse(k.words) as string[])
    words.set(k.trigger_id, config)
  }
  const first = new Map<string, Row>()
  for (const t of triggers.results) {
    if (t.kind === 'keyword') t.config = JSON.stringify({ ...JSON.parse(String(t.config)), ...(words.get(String(t.id)) ?? { include: [], exclude: [] }) })
    if (!first.has(String(t.automation_id))) first.set(String(t.automation_id), t)
  }
  const published = new Map(versions.results.map(v => [v.id, JSON.parse(v.graph) as Graph]))
  return rows.results.map(row => {
    const result = decode<AutomationRow>(row)
    result.flow_preview = flowPreview((result.published_version_id && published.get(result.published_version_id)) || result.draft_graph)
    const t = first.get(result.id)
    result.trigger_type = t ? triggerTypeOf(t.kind as string, t.widget_type as string | null) : null
    result.trigger_channel = t ? (t.channel_type as string | null) ?? null : null
    if (t) result.trigger_summary = summarizeTrigger(t)
    return result
  })
}

export async function getAutomation(db: D1Database, workspaceId: string, id: string): Promise<AutomationDetail | null> {
  assertWorkspace(workspaceId)
  // Uma ida: a versão publicada vem por subconsulta, sem esperar a linha da automação.
  const [rows, triggers, versions] = await db.batch<Row>([
    db.prepare("SELECT * FROM automations WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL").bind(workspaceId, id),
    db.prepare("SELECT t.*, (SELECT c.type FROM channels c WHERE c.workspace_id=t.workspace_id AND c.id=t.channel_id) AS channel_type FROM triggers t WHERE t.workspace_id = ? AND t.automation_id = ? AND t.status <> 'disabled' ORDER BY t.created_at, t.id")
      .bind(workspaceId, id),
    db.prepare(`SELECT id, automation_id, version, graph, published_by, created_at FROM automation_versions WHERE workspace_id = ? AND automation_id = ?
      AND id = (SELECT published_version_id FROM automations WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL)`)
      .bind(workspaceId, id, workspaceId, id),
  ])
  const row = rows!.results[0], version = versions!.results[0]
  if (!row) return null
  return { automation: decode<Automation>(row), triggers: triggers.results.map(trigger),
    published_version: version ? decode<AutomationVersion>(version) : null }
}

export async function saveDraft(db: D1Database, workspaceId: string, id: string, graph: unknown): Promise<{ ok: true; updated_at: string }> {
  assertWorkspace(workspaceId)
  const parsed = validateGraph(graph)
  const now = Date.now()
  const result = await db.prepare(`UPDATE automations SET draft_graph = ?, has_unpublished_changes = published_version_id IS NOT NULL,
    updated_at = ? WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL RETURNING updated_at`)
    .bind(jsonValue(parsed), now, workspaceId, id).first<Row>()
  return { ok: true, updated_at: new Date(Number(requireRow(result).updated_at)).toISOString() }
}

/** Algum passo que pausa a execução (espera ou pergunta) vem antes do passo, em qualquer caminho que chegue a ele. */
function waitsBefore(graph: { nodes: { id: string; type: string }[]; edges: { from: string; to: string }[] }, nodeId: string): boolean {
  const types = new Map(graph.nodes.map(n => [n.id, n.type]))
  const seen = new Set([nodeId]), pending = [nodeId]
  while (pending.length) {
    const current = pending.pop()!
    for (const edge of graph.edges) {
      if (edge.to !== current || seen.has(edge.from)) continue
      if (['smart_delay', 'question'].includes(types.get(edge.from) ?? '')) return true
      seen.add(edge.from); pending.push(edge.from)
    }
  }
  return false
}

export async function publishAutomation(db: D1Database, workspaceId: string, id: string): Promise<AutomationVersion> {
  assertWorkspace(workspaceId)
  const automation = requireRow(await db.prepare("SELECT draft_graph FROM automations WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL")
    .bind(workspaceId, id).first<Row>())
  const graph = validateGraph(JSON.parse(String(automation.draft_graph)))
  const disconnected = disconnectedSteps(graph)
  if (disconnected.length) throw new RepositoryError(`Passo solto: ${disconnected.join(', ')}. Ligue ao gatilho antes de publicar.`, 400)
  if (!graph.nodes.some(node => node.type === "trigger" || node.type === "starting_step")) {
    throw new RepositoryError("Falta o gatilho.", 400)
  }
  if (!graph.nodes.some(node => ["question", "message", "content", "default", "email_new", "whatsapp", "instagram", "telegram", "tiktok"].includes(node.type)
    || ['action', 'action_group'].includes(node.type) && (node.config.actions?.length ?? 0) > 0)) {
    throw new RepositoryError("Adicione uma mensagem ou uma ação antes de publicar.", 400)
  }
  for (const node of graph.nodes.filter(node => ['action', 'action_group'].includes(node.type))) {
    for (const raw of node.config.actions ?? []) {
      const result = actionSchema.safeParse(raw)
      if (!result.success) throw new RepositoryError('Complete os parâmetros da ação antes de publicar.', 400)
      try {
        await validateActionReference(db, workspaceId, result.data)
        if (result.data.type === 'pause_automations') {
          const duration = result.data.duration
          if (duration.value * { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 }[duration.unit] > 365 * 86400000) {
            throw new Error('Duração superior a um ano.')
          }
        }
      } catch { throw new RepositoryError('Confira os parâmetros e as referências das ações neste workspace.', 400) }
    }
  }
  for (const node of graph.nodes) {
    for (const raw of node.config.blocks ?? []) {
      const urls: unknown[] = raw.kind === 'media' ? [raw.url] : isCards(raw) ? (raw.cards as { imageUrl?: unknown }[]).map(c => c.imageUrl) : []
      if (urls.some(u => typeof u === 'string' && isManychatMediaUrl(u))) throw new RepositoryError(`Passo ${node.id}: a mídia ainda aponta para a ManyChat. Envie o arquivo de novo antes de publicar.`, 409)
      if (raw.kind === 'typing' && !typingBlockSchema.safeParse(raw).success) throw new RepositoryError('A digitação aceita de 1 a 10 segundos.', 400)
      if (raw.kind === 'quick_reply' && !quickReplyBlockSchema.safeParse(raw).success) throw new RepositoryError('Confira o título e o identificador das respostas rápidas.', 400)
      if (raw.kind !== 'button') continue
      const block = buttonBlockSchema.parse(raw)
      // Botão que inicia outra automação: o destino precisa existir publicado e ligado neste espaço.
      if (block.action.type === 'start_automation' && !await db.prepare(`SELECT id FROM automations WHERE workspace_id=? AND id=? AND status='live' AND deleted_at IS NULL AND published_version_id IS NOT NULL`)
        .bind(workspaceId, block.action.automation_id).first()) throw new RepositoryError(`Passo ${node.id}: o botão “${block.label}” inicia uma automação que não está publicada e ligada.`, 400)
      for (const action of block.actions ?? []) {
        try {
          if ('tag_id' in action) {
            if (!await db.prepare('SELECT id FROM tags WHERE workspace_id=? AND id=? AND archived=0').bind(workspaceId, action.tag_id).first()) throw new Error('Tag indisponível')
          } else {
            const field = await db.prepare("SELECT type FROM custom_fields WHERE workspace_id=? AND id=? AND scope='contact' AND archived=0").bind(workspaceId, action.field_id).first<{ type: string }>()
            if (!field) throw new Error('Campo indisponível')
            if (action.type === 'set_custom_field_value') validateFieldValue(field.type, action.value)
          }
        }
        catch { throw new RepositoryError('Confira a tag, o campo e o valor das ações do botão neste workspace.', 400) }
      }
    }
    if (node.type === 'start_automation' && !(typeof node.config.automation_id === 'string' && node.config.automation_id.trim()))
      throw new RepositoryError(`Não dá para publicar: o passo “Iniciar automação” (${node.id}) está sem destino. Escolha a automação que ele deve iniciar.`, 400)
    if (node.type === 'start_automation' && node.config.wait_for_finish !== undefined && typeof node.config.wait_for_finish !== 'boolean')
      throw new RepositoryError(`Não dá para publicar: no passo “Iniciar automação” (${node.id}), escolha se o fluxo espera a outra terminar ou segue sem esperar.`, 400)
    if (['start_automation', 'goto'].includes(node.type) && node.config.automation_id === id) {
      const waits = node.type === 'start_automation' && node.config.wait_for_finish === true
      if (waits) throw new RepositoryError(`Não dá para publicar: o passo “Iniciar automação” (${node.id}) espera a própria automação terminar, e ela nunca terminaria. Escolha outra automação.`, 400)
      if (!waitsBefore(graph, node.id)) throw new RepositoryError(`Não dá para publicar: o passo “Iniciar automação” (${node.id}) inicia a própria automação sem nenhuma espera antes, e ela se repetiria sem parar. Coloque uma espera ou uma pergunta antes dele, ou escolha outra automação.`, 400)
    }
    try { await validateLogicReferences(db, workspaceId, node.type, node.config) }
    catch (error) { throw new RepositoryError(`Passo ${node.id}: ${error instanceof Error ? error.message : 'Confira a espera ou condição.'}`, 400) }
    const texts = (node.config.blocks ?? []).flatMap(b => isCards(b) ? cardTexts(b) : b.kind === 'text' && typeof b.text === 'string' ? [b.text]
      : (b.kind === 'button' || b.kind === 'quick_reply') && typeof b.label === 'string' ? [b.label] : b.kind === 'media' && typeof b.url === 'string' ? [b.url] : 'type' in b && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])
    if (node.type === 'question') {
      const parsed = questionSchema.safeParse(node.config)
      if (!parsed.success) {
        const text = typeof node.config.text === 'string' && node.config.text.trim() ? `“${node.config.text.trim().slice(0, 40)}”` : node.id
        throw new RepositoryError(`Não dá para publicar: a pergunta ${text} está incompleta. ${[...new Set(parsed.error.issues.map(i => i.message))].join(' ')}`, 400)
      }
      const config = parsed.data
      if (questionSystemField(config.field_id)) {
        if (!questionSystemFieldFits(config.field_id, config.answer_type)) throw new RepositoryError(`Passo ${node.id}: o campo do sistema não combina com o tipo da resposta.`, 400)
      } else {
        const field = await db.prepare("SELECT type FROM custom_fields WHERE workspace_id=? AND id=? AND scope='contact' AND archived=0")
          .bind(workspaceId, config.field_id).first<{ type: string }>()
        if (!field || field.type !== questionFieldType(config.answer_type)) throw new RepositoryError(`Passo ${node.id}: escolha um campo de contato ativo e compatível.`, 400)
      }
      texts.push(config.text, config.retry_message)
    }
    try { await validateMessageVariables(db, workspaceId, texts) }
    catch (error) {
      if (error instanceof RepositoryError) throw new RepositoryError(`Passo ${node.id}: ${error.message}`, 400)
      throw error
    }
  }
  const versionId = crypto.randomUUID()
  const now = Date.now()
  // Both allocation and snapshot happen within D1's atomic batch. The graph predicate
  // refuses a stale publish when a concurrent save changed the validated draft.
  const results = await db.batch([
    db.prepare(`INSERT INTO automation_versions (id, workspace_id, automation_id, version, graph, published_by, created_at)
      SELECT ?, a.workspace_id, a.id, coalesce((SELECT max(v.version) FROM automation_versions v
        WHERE v.workspace_id = a.workspace_id AND v.automation_id = a.id), 0) + 1, a.draft_graph, NULL, ?
      FROM automations a WHERE a.workspace_id = ? AND a.id = ? AND a.deleted_at IS NULL AND a.draft_graph = ?`)
      .bind(versionId, now, workspaceId, id, automation.draft_graph),
    db.prepare(`UPDATE automations SET published_version_id = ?, has_unpublished_changes = 0, status = 'live', updated_at = ?
      WHERE workspace_id = ? AND id = ? AND EXISTS (SELECT 1 FROM automation_versions v
        WHERE v.workspace_id = ? AND v.id = ? AND v.automation_id = automations.id)`)
      .bind(versionId, now, workspaceId, id, workspaceId, versionId),
    db.prepare("SELECT id, automation_id, version, graph, published_by, created_at FROM automation_versions WHERE workspace_id = ? AND automation_id = ? AND id = ?")
      .bind(workspaceId, id, versionId),
  ])
  const version = results[2]?.results[0] as Row | undefined
  if (!version) throw new RepositoryError("O rascunho mudou. Tente publicar novamente.", 409)
  return decode<AutomationVersion>(version)
}
