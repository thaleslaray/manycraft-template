import { z } from 'zod'
import type { ProviderCtx } from './contract'
import type { TemplateDraft } from './template-draft'
import { variables } from './template-draft'
import { uploadHeaderMedia } from './meta-template-media'

/** Nome do ID da conta que guarda os modelos, o mesmo do campo da conexão (providers.ts, `wabaId`): as mensagens de modelos citam este. */
export const TEMPLATE_ACCOUNT_LABEL = 'ID da conta do WhatsApp Business (WABA)'

/** A rejected request is safe to correct; a missing confirmation must be reconciled before any retry. */
export class TemplateRequestError extends Error {
  /** `missing`: falta o ID da conta (WABA, ou a página no Messenger) ou o token; nada foi à Meta. `notice`: o que dizer à pessoa (pt-BR), quando se sabe. */
  constructor(readonly uncertain: boolean, readonly code?: number, readonly missing?: 'account' | 'credentials', readonly notice?: string) { super(notice ?? 'Não foi possível confirmar a revisão. Atualize os modelos antes de tentar novamente.') }
}
/** Conteúdo de um modelo que veio da Meta, já no formato do nosso rascunho. */
export type ProviderTemplateContent = Pick<TemplateDraft,'header'|'body'|'examples'|'footer'|'buttons'> & { unavailable?:string }
/** `headerExample`: o identificador da mídia de exemplo que o envio subiu para a Meta (guardado no modelo para não subir de novo). */
export type ProviderTemplate = { id:string; name?:string; language?:string; status:string; category:string; quality:string; rejectionReason:string|null; content?:ProviderTemplateContent; headerExample?:string }
// Tolerante de propósito: uma conta real tem status/categorias/componentes que não conhecemos (IN_APPEAL, FLAGGED, LIMIT_EXCEEDED, TRANSACTIONAL...).
const remote = z.object({ id:z.coerce.string().min(1), name:z.string().optional(), language:z.string().optional(), status:z.string(), category:z.string().optional(),
  quality_score:z.object({score:z.string().nullable().optional()}).optional(), rejected_reason:z.string().max(2000).optional().catch(undefined), components:z.array(z.unknown()).optional() })
export const statuses:Record<string,string> = { PENDING:'pending', IN_APPEAL:'pending', APPROVED:'approved', REJECTED:'rejected', PAUSED:'paused', FLAGGED:'paused', LIMIT_EXCEEDED:'paused', DISABLED:'disabled', DELETED:'deleted', PENDING_DELETION:'deleted', ARCHIVED:'deleted' }
export const categories:Record<string,string> = { UTILITY:'utility', TRANSACTIONAL:'utility', MARKETING:'marketing', AUTHENTICATION:'authentication', OTP:'authentication' }
const qualities = ['green','yellow','red']
type Component = { type?:string; format?:string; text?:string; example?:Record<string,unknown>; buttons?:{type?:string;text?:string;url?:string;example?:string[]}[] }
function examplesOf(c:Component|undefined,field:'body'|'header'):Record<string,string> {
  const out:Record<string,string>={}, e=c?.example ?? {}
  const named=e[`${field}_text_named_params`]
  if (Array.isArray(named)) for (const n of named as {param_name?:string;example?:string}[]) if (n?.param_name && typeof n.example==='string') out[n.param_name]=n.example
  const positional=e[`${field}_text`]
  const values=Array.isArray(positional) ? (field==='body' ? (positional[0] as unknown) : positional) : undefined
  if (Array.isArray(values)) values.forEach((v,i)=>{ if (typeof v==='string') out[String(i+1)]=v })
  return out
}
const unsupportedButtons:Record<string,string> = {
  COPY_CODE:'Botão Copiar código exige o código no envio, que ainda não é suportado.',
  OTP:'Botão de código de autenticação (OTP) não é suportado no envio.',
  FLOW:'Botão de Flow não é suportado no envio.',
  MPM:'Botão de mensagem multiproduto (catálogo) não é suportado no envio.',
  SPM:'Botão de produto do catálogo não é suportado no envio.',
  CATALOG:'Botão de catálogo não é suportado no envio.',
  VOICE_CALL:'Botão de ligação não é suportado no envio.',
}
const unsupportedComponents:Record<string,string> = {
  CAROUSEL:'Modelo de carrossel não é suportado no envio.',
  LIMITED_TIME_OFFER:'Modelo de oferta por tempo limitado não é suportado no envio.',
}
/** Converte os componentes da Graph API. Conteúdo que o envio não sabe montar vira `unavailable` (motivo em português) em vez de sumir ou virar "modelo só de corpo". */
function contentOf(components:unknown[]|undefined,category?:string):ProviderTemplateContent {
  const list=(components ?? []).filter((c):c is Component=>!!c && typeof c==='object')
  const body=list.find(c=>c.type==='BODY'), header=list.find(c=>c.type==='HEADER'), footer=list.find(c=>c.type==='FOOTER'), buttons=list.find(c=>c.type==='BUTTONS')
  const reasons:string[]=[]
  if ((category ?? '').toUpperCase()==='AUTHENTICATION' || (category ?? '').toUpperCase()==='OTP') reasons.push('Modelo de autenticação (OTP) não é suportado no envio.')
  for (const c of list) { const why=unsupportedComponents[(c.type ?? '').toUpperCase()]; if (why && !reasons.includes(why)) reasons.push(why) }
  // Cabeçalho de texto: 60 caracteres (P/templates/components.md); só o corpo vai até 1.024.
  const text=body?.text ?? ''
  if (!body?.text) { if (!reasons.length) reasons.push('Modelo sem corpo de texto não é suportado no envio.') }
  else if (text.length>1024) reasons.push('Corpo com mais de 1.024 caracteres não é suportado.')
  const examples=examplesOf(body,'body')
  let h:ProviderTemplateContent['header']={type:'none'}
  if (header) {
    const format=header.format ?? 'TEXT'
    if (format==='TEXT') {
      if (!header.text || header.text.length>60) reasons.push('Cabeçalho de texto inválido ou com mais de 60 caracteres.')
      else { const ex=Object.values(examplesOf(header,'header'))[0]; h={type:'text',text:header.text,...(ex?{example:ex}:{})} }
    } else if (['IMAGE','VIDEO','DOCUMENT'].includes(format)) {
      const handle=(header.example?.header_handle as unknown[]|undefined)?.[0]
      if (typeof handle!=='string' || !/^https?:\/\//.test(handle)) reasons.push('Cabeçalho de mídia sem endereço do arquivo de exemplo para reenviar.')
      else h={type:format.toLowerCase() as 'image'|'video'|'document',mediaUrl:handle,example:handle}
    } else reasons.push(format==='LOCATION' ? 'Cabeçalho de localização não é suportado no envio.' : `Cabeçalho do tipo ${format} não é suportado no envio.`)
  }
  // Resposta rápida e URL são reenviadas; telefone é estático e a Meta o aplica sozinha. O resto precisa de parâmetro que o envio não monta.
  const bs:ProviderTemplateContent['buttons']=[]
  for (const b of buttons?.buttons ?? []) {
    const kind=(b.type ?? '').toUpperCase()
    if (kind==='QUICK_REPLY' && b.text) bs.push({type:'reply',text:b.text})
    else if (kind==='URL' && b.text && b.url) bs.push({type:'url',text:b.text,url:b.url,...(b.example?.[0]?{example:b.example[0]}:{})})
    else if (kind!=='PHONE_NUMBER') { const why=unsupportedButtons[kind] ?? `Botão do tipo ${kind || 'desconhecido'} não é suportado no envio.`; if (!reasons.includes(why)) reasons.push(why) }
  }
  return { header:h, body:text.slice(0,1024), examples, footer:(footer?.text ?? '').slice(0,60), buttons:bs.slice(0,10), ...(reasons.length?{unavailable:reasons.join(' ')}:{}) }
}
const dto = (r:z.infer<typeof remote>):ProviderTemplate => {
  const score=r.quality_score?.score?.toLowerCase()
  return { id:r.id, name:r.name, language:r.language, status:statuses[r.status.toUpperCase()] ?? 'pending', category:categories[(r.category ?? '').toUpperCase()] ?? 'utility',
    quality:score && qualities.includes(score) ? score : 'unknown', rejectionReason:r.rejected_reason ?? null, ...(r.components ? { content:contentOf(r.components,r.category) } : {}) }
}
/** ID da conta onde ficam os modelos: página (Messenger) ou conta comercial do WhatsApp (WABA). No WhatsApp vale primeiro a conta provada na Meta
 * (`settings.accountId`, a dona do número): a digitada pode ser uma conta compartilhada que também lista o número, onde a Meta não procura os modelos. */
export function templateAccountOf(kind: string, credentials: Record<string, string | undefined>, settings: Record<string, unknown>): string | undefined {
  const proved = typeof settings.accountId === 'string' && /^\d+$/.test(settings.accountId) ? settings.accountId : undefined
  const waba = kind === 'messenger' ? credentials.pageId : proved ?? credentials.wabaId ?? settings.wabaId
  return typeof waba === 'string' && /^\d+$/.test(waba) ? waba : undefined
}
function graphBase(ctx:ProviderCtx) {
  const dev=ctx.connection.settings.apiBase
  return `${typeof dev==='string' && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(dev) ? dev : 'https://graph.facebook.com'}/v26.0`
}
function endpoint(ctx:ProviderCtx) {
  // Modelos utility do Messenger ficam na página; os do WhatsApp, na conta comercial (WABA).
  const waba=templateAccountOf(ctx.connection.kind, ctx.credentials, ctx.connection.settings)
  if (!ctx.credentials.accessToken) throw new TemplateRequestError(false, undefined, 'credentials')
  if (!templateAccountOf(ctx.connection.kind, ctx.credentials, ctx.connection.settings)) throw new TemplateRequestError(false, undefined, 'account')
  return `${graphBase(ctx)}/${waba}/message_templates`
}
async function call(ctx:ProviderCtx,url:string,body?:unknown) {
  let response:Response
  try { response=await ctx.fetch(url,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${ctx.credentials.accessToken}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)}) }
  catch { throw new TemplateRequestError(true) }
  if (!response.ok) {
    const code=await response.json().then((b:unknown)=>{const code=(b as {error?:{code?:unknown}}|null)?.error?.code;return typeof code==='number'?code:undefined},()=>undefined)
    throw new TemplateRequestError(response.status>=500,code)
  }
  try { return await response.json() } catch { throw new TemplateRequestError(true) }
}
function component(type:string,text:string,examples:Record<string,string>) {
  const keys=variables(text).sort((a,b)=>/^\d+$/.test(a)?Number(a)-Number(b):a.localeCompare(b))
  if (!keys.length) return {type,text}
  const named=!/^\d+$/.test(keys[0]), lower=type.toLowerCase()
  return {type,text,example:named?{[`${lower}_text_named_params`]:keys.map(k=>({param_name:k,example:examples[k]}))}
    :{[`${lower}_text`]:type==='BODY'?[keys.map(k=>examples[k])]:keys.map(k=>examples[k])}}
}
export const metaTemplates = {
  async create(ctx:ProviderCtx,d:TemplateDraft):Promise<ProviderTemplate> {
    const components:Record<string,unknown>[]=[]
    // Cabeçalho de mídia sem identificador: a mídia do endereço sobe agora pela Resumable Upload API e o identificador volta para ser guardado.
    let uploaded:string|undefined
    if (d.header.type==='text') components.push({...component('HEADER',d.header.text!,Object.fromEntries(variables(d.header.text!).map(k=>[k,d.header.example!]))),format:'TEXT'})
    else if (d.header.type!=='none') {
      if (!d.header.example) { endpoint(ctx); uploaded=await uploadHeaderMedia(ctx,graphBase(ctx),d.header.type,d.header.mediaUrl!) }
      components.push({type:'HEADER',format:d.header.type.toUpperCase(),example:{header_handle:[d.header.example ?? uploaded]}})
    }
    components.push(component('BODY',d.body,d.examples))
    if (d.footer) components.push({type:'FOOTER',text:d.footer})
    if (d.buttons.length) components.push({type:'BUTTONS',buttons:d.buttons.map(b=>b.type==='reply'?{type:'QUICK_REPLY',text:b.text}:{type:'URL',text:b.text,url:b.url,...(b.example?{example:[b.example]}:{})})})
    const parsed=remote.safeParse(await call(ctx,endpoint(ctx),{name:d.name,language:d.language,category:d.category.toUpperCase(),parameter_format:variables(d.body+' '+(d.header.text??'')).some(k=>!/^[0-9]+$/.test(k))?'NAMED':'POSITIONAL',components}))
    if (!parsed.success) throw new TemplateRequestError(true)
    return { ...dto(parsed.data), ...(uploaded ? { headerExample:uploaded } : {}) }
  },
  async list(ctx:ProviderCtx):Promise<ProviderTemplate[]> {
    const all:ProviderTemplate[]=[]
    let after:string|undefined
    for (let page=0;page<100;page++) {
      const url=new URL(endpoint(ctx));url.searchParams.set('fields','id,name,language,status,category,quality_score,rejected_reason,components,parameter_format');url.searchParams.set('limit','100')
      if(after)url.searchParams.set('after',after)
      const parsed=z.object({data:z.array(z.unknown()),paging:z.object({next:z.string().optional(),cursors:z.object({after:z.string().optional()}).optional()}).optional()}).safeParse(await call(ctx,url.toString()))
      if(!parsed.success)throw new TemplateRequestError(true)
      for(const item of parsed.data.data){const one=remote.safeParse(item);if(one.success)all.push(dto(one.data))}
      if(!parsed.data.paging?.next)return all
      const cursor=parsed.data.paging.cursors?.after
      if(!cursor || cursor===after)throw new TemplateRequestError(true)
      after=cursor
    }
    throw new TemplateRequestError(true)
  },
}
