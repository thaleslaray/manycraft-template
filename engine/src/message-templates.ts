import { Hono } from 'hono'
import { connectionRuntime } from './channels/core/runtime'
import { TEMPLATE_ACCOUNT_LABEL, templateAccountOf, TemplateRequestError, type ProviderTemplate } from './channels/meta-templates'
import { openRow } from './channels/core/credentials'
import { NO_CREDENTIALS } from './channels/core/meta-error'
import { HTTPException } from 'hono/http-exception'
import { templateDraftSchema as draftSchema, type TemplateDraft } from './channels/template-draft'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { json } from './security'
import { failureNotice, noteConnectionFailure } from './channels/core/failure'
import { connectionColumns, connectionFromRow, type ConnectionRow } from './channels/core/connection'

export const messageTemplates = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const MISSING_ACCOUNT = `Informe o ${TEMPLATE_ACCOUNT_LABEL} em Trocar credencial para sincronizar e enviar modelos.`
/** Falta de dado da conexão (conta ou token): 409 com o que fazer, em vez do "tente novamente" de falha da Meta. */
function missingData(error: unknown): HTTPException | undefined {
  if (!(error instanceof TemplateRequestError) || !error.missing) return undefined
  return new HTTPException(409, { message: error.missing === 'account' ? MISSING_ACCOUNT : NO_CREDENTIALS })
}
const notFound = () => new HTTPException(404, { message: 'Conexão ou modelo não encontrado.' })
async function connection(env: Env, workspace: string, id: string) {
  const row = await env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL`).bind(workspace,id).first<ConnectionRow>()
  if (!row) throw notFound()
  const c = connectionFromRow(row)
  if (!c.profile.templates) throw new HTTPException(409, { message: 'Esta conexão não oferece modelos de mensagem.' })
  return c
}
type Stored = { updated_at: number; provider_id: string | null; id: string; name_human: string; category: string; language_code: string; header_type: TemplateDraft['header']['type']; header_text: string | null; header_media_url: string | null; header_example: string | null; body: string; example: string; footer: string; buttons: string; status: string; quality: string; submitted_at: number | null; synced_at: number | null; rejection_reason: string | null; unavailable_reason: string | null }
function dto(row: Stored) {
  return { id: row.id, name: row.name_human, category: row.category, language: row.language_code,
    header: { type: row.header_type, ...(row.header_type === 'text' ? { text: row.header_text ?? '', ...(row.header_example ? { example: row.header_example } : {}) } : row.header_type !== 'none' ? { mediaUrl: row.header_media_url, ...(row.header_example ? { example: row.header_example } : {}) } : {}) },
    body: row.body, examples: JSON.parse(row.example), footer: row.footer, buttons: JSON.parse(row.buttons), status: row.status, quality: row.quality,
    submittedAt: row.submitted_at, syncedAt: row.synced_at, rejectionReason: row.rejection_reason, unavailableReason: row.unavailable_reason }
}
messageTemplates.get('/options', async c => {
  authorize(c.var.principal,'read')
  const ws = c.var.principal.workspaceId
  const rows = await c.env.DB.prepare(`SELECT ${connectionColumns},credentials_ciphertext,credentials_iv,credentials_key_version FROM channels WHERE workspace_id=? AND archived_at IS NULL ORDER BY display_name,id`).bind(ws).all<ConnectionRow & Parameters<typeof openRow>[3] & object>()
  // canSync só com a conta (WABA/página) e o token guardados: sem eles a sincronização recusaria sem chamar a Meta.
  const connections = await Promise.all(rows.results.map(async raw => {
    const row = connectionFromRow(raw)
    if (!row.profile.templates) return undefined
    const syncs = row.profile.templates.managedBy === 'provider_api'
    const credentials = syncs ? await openRow(c.env, ws, row.id, raw).catch(() => ({})) as Record<string, string | undefined> : {}
    return { id: row.id, label: row.displayName ?? row.externalId, canSync: syncs && !!credentials.accessToken && !!templateAccountOf(row.kind, credentials, row.settings) }
  }))
  return c.json({ canEdit: ['owner','administrator','editor'].includes(c.var.principal.role), connections: connections.filter(Boolean) })
})
messageTemplates.get('/:connection', async c => {
  const ws = c.var.principal.workspaceId, id = c.req.param('connection')
  // A leitura sai junto com a checagem da conexão (uma onda); a checagem continua barrando antes de qualquer linha sair.
  const loaded = c.env.DB.prepare('SELECT * FROM message_templates WHERE workspace_id=? AND channel_id=? AND status<>\'deleted\' ORDER BY created_at DESC,id').bind(ws,id).all<Stored>()
  loaded.catch(() => undefined)
  await connection(c.env,ws,id)
  return c.json((await loaded).results.map(dto))
})
/** Analytics dos modelos da conexão: transmissões que usaram cada modelo, envios, falhas, ignorados e cliques nos links. */
messageTemplates.get('/:connection/analytics', async c => {
  const ws = c.var.principal.workspaceId, id = c.req.param('connection')
  const loaded = c.env.DB.prepare(`SELECT t.id,t.name_human AS name,t.category,
      (SELECT count(*) FROM broadcasts b WHERE b.workspace_id=t.workspace_id AND json_extract(b.template,'$.id')=t.id) AS broadcasts,
      (SELECT count(*) FROM broadcast_recipients r JOIN broadcasts b ON b.workspace_id=r.workspace_id AND b.id=r.broadcast_id WHERE b.workspace_id=t.workspace_id AND json_extract(b.template,'$.id')=t.id AND r.status='sent') AS sent,
      (SELECT count(*) FROM broadcast_recipients r JOIN broadcasts b ON b.workspace_id=r.workspace_id AND b.id=r.broadcast_id WHERE b.workspace_id=t.workspace_id AND json_extract(b.template,'$.id')=t.id AND r.status='failed') AS failed,
      (SELECT count(*) FROM broadcast_recipients r JOIN broadcasts b ON b.workspace_id=r.workspace_id AND b.id=r.broadcast_id WHERE b.workspace_id=t.workspace_id AND json_extract(b.template,'$.id')=t.id AND r.status='skipped') AS skipped,
      (SELECT count(DISTINCT l.contact_channel_id) FROM broadcast_links l JOIN broadcasts b ON b.workspace_id=l.workspace_id AND b.id=l.broadcast_id WHERE b.workspace_id=t.workspace_id AND json_extract(b.template,'$.id')=t.id AND l.clicked_at IS NOT NULL) AS clicked,
      (SELECT max(r.sent_at) FROM broadcast_recipients r JOIN broadcasts b ON b.workspace_id=r.workspace_id AND b.id=r.broadcast_id WHERE b.workspace_id=t.workspace_id AND json_extract(b.template,'$.id')=t.id) AS last_sent_at
    FROM message_templates t WHERE t.workspace_id=? AND t.channel_id=? AND t.status<>'deleted' ORDER BY t.created_at DESC,t.id`).bind(ws,id).all<{ sent: number; clicked: number }>()
  loaded.catch(() => undefined)
  await connection(c.env,ws,id)
  const rows = await loaded
  return c.json({ items: rows.results.map(r => ({ ...r, click_rate: r.sent ? r.clicked / r.sent : 0 })) })
})
messageTemplates.post('/:connection', async c => {
  authorize(c.var.principal,'edit')
  const ws = c.var.principal.workspaceId, id = c.req.param('connection')
  await connection(c.env,ws,id)
  const d = draftSchema.parse(await json(c.req.raw)), templateId = crypto.randomUUID()
  await unique(c.env,ws,id,d.name,d.language)
  await c.env.DB.prepare(`INSERT INTO message_templates(id,workspace_id,channel_id,group_id,name_human,category,language_code,header_type,header_text,header_media_url,header_example,body,example,footer,buttons,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft')`)
    .bind(templateId,ws,id,templateId,d.name,d.category,d.language,d.header.type,d.header.text ?? null,d.header.mediaUrl ?? null,d.header.example ?? null,d.body,JSON.stringify(d.examples),d.footer,JSON.stringify(d.buttons)).run()
  return c.json(dto((await c.env.DB.prepare('SELECT * FROM message_templates WHERE workspace_id=? AND id=?').bind(ws,templateId).first<Stored>())!),201)
})

async function unique(env: Env, ws: string, connectionId: string, name: string, language: string, except = '') {
  const duplicate = await env.DB.prepare('SELECT id FROM message_templates WHERE workspace_id=? AND channel_id=? AND name_human=? AND language_code=? AND id<>?').bind(ws,connectionId,name,language,except).first()
  if (duplicate) throw new HTTPException(409,{message:'Já existe um modelo com este nome e idioma nesta conexão.'})
}
async function stored(env: Env, ws: string, connectionId: string, id: string) {
  const row=await env.DB.prepare('SELECT * FROM message_templates WHERE workspace_id=? AND channel_id=? AND id=?').bind(ws,connectionId,id).first<Stored>()
  if(!row)throw notFound()
  return row
}
messageTemplates.patch('/:connection/:id',async c=>{
  authorize(c.var.principal,'edit')
  const ws=c.var.principal.workspaceId, connectionId=c.req.param('connection'), id=c.req.param('id')
  await connection(c.env,ws,connectionId)
  const row=await stored(c.env,ws,connectionId,id)
  if(row.status!=='draft')throw new HTTPException(409,{message:'O modelo está travado após o envio para revisão.'})
  const d=draftSchema.parse(await json(c.req.raw))
  await unique(c.env,ws,connectionId,d.name,d.language,id)
  const changed=await c.env.DB.prepare(`UPDATE message_templates SET name_human=?,category=?,language_code=?,header_type=?,header_text=?,header_media_url=?,header_example=?,body=?,example=?,footer=?,buttons=?,updated_at=MAX(?,updated_at+1) WHERE workspace_id=? AND channel_id=? AND id=? AND status='draft' RETURNING *`)
    .bind(d.name,d.category,d.language,d.header.type,d.header.text??null,d.header.mediaUrl??null,d.header.example??null,d.body,JSON.stringify(d.examples),d.footer,JSON.stringify(d.buttons),Date.now(),ws,connectionId,id).first<Stored>()
  if(!changed)throw new HTTPException(409,{message:'O modelo já foi enviado para revisão.'})
  return c.json(dto(changed))
})
async function provider(env: Env, ws: string, connectionId: string) {
  const conn=await connection(env,ws,connectionId)
  if(conn.profile.templates?.managedBy!=='provider_api')throw new HTTPException(409,{message:'Esta conexão não sincroniza modelos pelo provedor.'})
  const rt=await connectionRuntime(env,ws,connectionId,{secrets:false})
  if(!rt.provider?.templates)throw new HTTPException(409,{message:'O provedor desta conexão não gerencia modelos.'})
  return { api:rt.provider.templates, ctx:{connection:rt.connection,credentials:await rt.credentials(),fetch:rt.fetch} }
}
messageTemplates.post('/:connection/:id/submit',async c=>{
  authorize(c.var.principal,'edit')
  const ws=c.var.principal.workspaceId, connectionId=c.req.param('connection'), id=c.req.param('id')
  const {api,ctx}=await provider(c.env,ws,connectionId)
  const row=await stored(c.env,ws,connectionId,id)
  if(row.status!=='draft')throw new HTTPException(409,{message:'Este modelo já foi enviado. Atualize os modelos para consultar a revisão.'})
  const draft=draftSchema.parse((({name,category,language,header,body,examples,footer,buttons})=>({name,category,language,header,body,examples,footer,buttons}))(dto(row)))
  const claimed=await c.env.DB.prepare("UPDATE message_templates SET status='submitting',submitted_at=?,updated_at=? WHERE workspace_id=? AND id=? AND status='draft' AND updated_at=? RETURNING id").bind(Date.now(),Date.now(),ws,id,row.updated_at).first()
  if(!claimed)throw new HTTPException(409,{message:'O modelo mudou. Recarregue antes de continuar.'})
  try {
    const remote=await api.create(ctx,draft)
    await saveRemote(c.env,ws,connectionId,id,remote,true)
  } catch(error) {
    const definite=error instanceof TemplateRequestError && !error.uncertain
    const reverted=await c.env.DB.prepare("UPDATE message_templates SET status=?,submitted_at=?,updated_at=MAX(?,updated_at+1) WHERE workspace_id=? AND id=? AND status='submitting' AND provider_id IS NULL RETURNING id").bind(definite?'draft':'uncertain',definite?null:Date.now(),Date.now(),ws,id).first()
    if(!reverted)return c.json(dto(await stored(c.env,ws,connectionId,id)))
    const missing=missingData(error); if(missing)throw missing
    if(error instanceof TemplateRequestError&&error.notice)throw new HTTPException(definite?422:503,{message:error.notice})
    throw new HTTPException(definite?422:503,{message:definite?`O provedor não aceitou o modelo. Confira a credencial, o ${TEMPLATE_ACCOUNT_LABEL} e os campos antes de tentar novamente.`:'Revisão sem confirmação. A edição permanece travada; use Atualizar modelos para reconciliar.'})
  }
  return c.json(dto(await stored(c.env,ws,connectionId,id)))
})
const GONE='Este modelo não existe na conta desta conexão. Crie o modelo nessa conta ou confira o ID da conta.'
async function saveRemote(env:Env,ws:string,connectionId:string,id:string,r:ProviderTemplate,creation=false) {
  await env.DB.prepare(`UPDATE message_templates SET header_example=coalesce(?,header_example),provider_id=?,status=?,category=?,quality=?,rejection_reason=?,unavailable_reason=CASE WHEN ? THEN ? WHEN unavailable_reason=? THEN NULL ELSE unavailable_reason END,synced_at=?,updated_at=? WHERE workspace_id=? AND channel_id=? AND id=? AND status<>\'draft\'${creation ? " AND status='submitting' AND provider_id IS NULL" : ''}`)
    .bind(r.headerExample ?? null,r.id,r.status,r.category,r.quality,r.rejectionReason,r.content?1:0,r.content?.unavailable ?? null,GONE,Date.now(),Date.now(),ws,connectionId,id).run()
}
messageTemplates.post('/:connection/sync',async c=>{
  authorize(c.var.principal,'edit')
  const ws=c.var.principal.workspaceId, connectionId=c.req.param('connection'), {api,ctx}=await provider(c.env,ws,connectionId)
  let remote:ProviderTemplate[]
  try{remote=await api.list(ctx)}catch(error){
    if(error instanceof TemplateRequestError&&error.code===190){
      await noteConnectionFailure(c.env,ws,connectionId,{ok:false,reason:'rejected',code:'190',detail:'token'})
      throw new HTTPException(409,{message:failureNotice({ok:false,reason:'rejected',code:'190',detail:'token'})})
    }
    const missing=missingData(error); if(missing)throw missing
    throw new HTTPException(503,{message:'Não foi possível atualizar os modelos. Tente novamente.'})
  }
  const local=await c.env.DB.prepare("SELECT * FROM message_templates WHERE workspace_id=? AND channel_id=? AND status NOT IN ('draft','deleted')").bind(ws,connectionId).all<Stored>()
  const known=new Set<string>()
  // Primeiro pelo id da Meta; quem sobrar casa por nome e idioma (a conta da conexão pode ter sido trocada e o id mudou).
  const pairs=new Map<string,ProviderTemplate>()
  for(const row of local.results){
    const match=row.provider_id?remote.find(r=>r.id===row.provider_id):undefined
    if(match){known.add(match.id);pairs.set(row.id,match)}
  }
  for(const row of local.results){
    if(pairs.has(row.id))continue
    const match=remote.find(r=>!known.has(r.id)&&r.status!=='deleted'&&r.name===row.name_human&&r.language===row.language_code)
    if(match){known.add(match.id);pairs.set(row.id,match)}
  }
  for(const row of local.results){
    const match=pairs.get(row.id)
    if(match)await saveRemote(c.env,ws,connectionId,row.id,match)
    // Já esteve na Meta e não está mais na conta desta conexão: continua na lista, mas fora do envio.
    else if(row.provider_id)await c.env.DB.prepare('UPDATE message_templates SET unavailable_reason=?,synced_at=?,updated_at=? WHERE workspace_id=? AND channel_id=? AND id=?').bind(GONE,Date.now(),Date.now(),ws,connectionId,row.id).run()
  }
  // Modelos criados direto na Meta (ou por outra ferramenta) passam a existir aqui, para uso em fluxo e transmissão.
  let imported=0,skipped=0
  for(const r of remote){
    if(known.has(r.id)||r.status==='deleted')continue
    if(!r.name||!r.language||!r.content){skipped++;continue}
    const h=r.content.header, id=crypto.randomUUID()
    const created=await c.env.DB.prepare(`INSERT OR IGNORE INTO message_templates(id,workspace_id,channel_id,group_id,name_human,category,language_code,header_type,header_text,header_media_url,header_example,body,example,footer,buttons,status,quality,provider_id,rejection_reason,unavailable_reason,submitted_at,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
      .bind(id,ws,connectionId,id,r.name,r.category,r.language,h.type,h.text??null,h.mediaUrl??null,h.example??null,r.content.body,JSON.stringify(r.content.examples),r.content.footer,JSON.stringify(r.content.buttons),r.status,r.quality,r.id,r.rejectionReason,r.content.unavailable ?? null,Date.now(),Date.now()).first()
    if(created)imported++;else skipped++
  }
  return c.json({syncedAt:Date.now(),imported,skipped})
})
