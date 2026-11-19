import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { IntegrationEnv } from '../integrations'
import { ensureMarketing } from '../channels/core/marketing'
import { variables, type TemplateDraft } from '../channels/template-draft'
import type { OutboundMessage, TemplateCategory, TemplateComponent, TemplateTextParameter } from '../channels/types'

const inputSchema = z.object({ id: z.string().min(1).max(512), params: z.record(z.string().max(128), z.string().trim().min(1).max(1024)) }).strict()
type StoredTemplate = {
  name_human: string; language_code: string; header_type: TemplateDraft['header']['type']; header_text: string | null;
  header_media_url: string | null; body: string; category: TemplateCategory; footer: string; buttons: string; unavailable_reason: string | null
}
const invalid = () => new HTTPException(400, { message: 'Preencha as variáveis do modelo sem campos extras.' })
const textParameter = (key: string, text: string): TemplateTextParameter => ({ type: 'text', text, ...(/^\d+$/.test(key) ? {} : { parameter_name: key }) })

/** Approved content stays on the server; callers supply only values, with section-qualified keys outside the body. */
export async function prepareTemplateMessage(env: IntegrationEnv, workspaceId: string, connectionId: string,
  input: { id: string; params: Record<string, string> }): Promise<{ message: Extract<OutboundMessage, { kind: 'template' }>; text: string }> {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) throw invalid()
  const row = await env.DB.prepare(`SELECT name_human,language_code,header_type,header_text,header_media_url,body,footer,buttons,unavailable_reason,category
    FROM message_templates WHERE workspace_id=? AND channel_id=? AND id=? AND status='approved'`)
    .bind(workspaceId, connectionId, parsed.data.id).first<StoredTemplate>()
  if (!row) throw new HTTPException(404, { message: 'Modelo aprovado não encontrado nesta conexão.' })
  if (row.unavailable_reason) throw new HTTPException(409, { message: `Este modelo não pode ser enviado: ${row.unavailable_reason}` })
  if (row.category === 'marketing') await ensureMarketing(env, workspaceId, connectionId)
  const params = parsed.data.params, bodyKeys = variables(row.body), headerKeys = row.header_type === 'text' ? variables(row.header_text ?? '') : []
  const buttons = JSON.parse(row.buttons) as TemplateDraft['buttons']
  const required = [...bodyKeys, ...headerKeys.map(key => `header:${key}`), ...buttons.flatMap((button,index) => variables(button.url ?? '').map(key => `button:${index}:${key}`))]
  if (bodyKeys.includes('language_code') || required.some(key => !Object.hasOwn(params,key)) || Object.keys(params).some(key => !required.includes(key))) throw invalid()
  const render = (text: string, prefix = '') => text.replace(/\{\{([a-z][a-z_]*|[1-9]\d*)\}\}/g, (_match,key:string) => params[`${prefix}${key}`])
  const components: TemplateComponent[] = []
  if (headerKeys.length) components.push({type:'header',parameters:headerKeys.map(key => textParameter(key,params[`header:${key}`]))})
  if (row.header_type === 'image') components.push({type:'header',parameters:[{type:'image',image:{link:row.header_media_url!}}]})
  if (row.header_type === 'video') components.push({type:'header',parameters:[{type:'video',video:{link:row.header_media_url!}}]})
  if (row.header_type === 'document') components.push({type:'header',parameters:[{type:'document',document:{link:row.header_media_url!}}]})
  buttons.forEach((button,index) => {
    const keys = variables(button.url ?? '')
    if (button.type === 'url' && keys.length) components.push({type:'button',sub_type:'url',index:String(index),parameters:keys.map(key => ({type:'text',text:params[`button:${index}:${key}`]}))})
  })
  const text = [row.header_type === 'text' ? render(row.header_text ?? '', 'header:') : row.header_media_url,
    render(row.body),row.footer,...buttons.map((button,index) => button.url ? `${button.text}: ${render(button.url,`button:${index}:`)}` : button.text)].filter(Boolean).join('\n')
  return {message:{kind:'template',templateId:row.name_human,category:row.category,params:{language_code:row.language_code,...Object.fromEntries(bodyKeys.map(key => [key,params[key]]))},...(components.length ? {components} : {})},text}
}

/** What the inbox shows for a template sent by an automation or broadcast: the name and the text the contact got (header, body and
 * button links with the values filled in, footer, button titles), from the stored model. Without the model, only the name. */
export async function templateDisplayText(env: Pick<IntegrationEnv, 'DB'>, workspaceId: string, connectionId: string,
  message: Extract<OutboundMessage, { kind: 'template' }>): Promise<string> {
  const title = `[Modelo: ${message.templateId}]`
  const row = await env.DB.prepare(`SELECT header_type,header_text,header_media_url,body,footer,buttons FROM message_templates
    WHERE workspace_id=? AND channel_id=? AND name_human=? AND (? IS NULL OR language_code=?) ORDER BY status='approved' DESC LIMIT 1`)
    .bind(workspaceId, connectionId, message.templateId, message.params.language_code ?? null, message.params.language_code ?? null)
    .first<Pick<StoredTemplate, 'header_type' | 'header_text' | 'header_media_url' | 'body' | 'footer' | 'buttons'>>()
  if (!row) return title
  const header = message.components?.find(c => c.type === 'header')
  const headerText = header?.type === 'header' ? header.parameters.filter((p): p is TemplateTextParameter => p.type === 'text') : []
  const fill = (text: string, value: (key: string, at: number) => string | undefined) => {
    let at = 0
    return text.replace(/\{\{([a-z][a-z_]*|[1-9]\d*)\}\}/g, (match, key: string) => value(key, at++) ?? match)
  }
  const buttons = JSON.parse(row.buttons) as TemplateDraft['buttons']
  const urlOf = (index: number, url: string) => {
    const component = message.components?.find(c => c.type === 'button' && c.index === String(index))
    return fill(url, (_key, at) => component?.type === 'button' ? component.parameters[at]?.text : undefined)
  }
  return [title,
    row.header_type === 'text' ? fill(row.header_text ?? '', (key, at) => (headerText.find(p => p.parameter_name === key) ?? headerText[at])?.text) : row.header_media_url,
    fill(row.body, key => message.params[key]), row.footer,
    ...buttons.map((button, index) => button.url ? `${button.text}: ${urlOf(index, button.url)}` : button.text)].filter(Boolean).join('\n')
}

/** The contact asked the provider to stop marketing, and this is a marketing template: it must not go to them (the provider would refuse it anyway). */
export async function marketingBlocked(env: Pick<IntegrationEnv, 'DB'>, workspaceId: string, connectionId: string, externalUserId: string, message: OutboundMessage): Promise<boolean> {
  if (message.kind !== 'template') return false
  return !!await env.DB.prepare(`SELECT 1 AS blocked FROM contact_channels cc WHERE cc.workspace_id=? AND cc.channel_id=? AND cc.external_user_id=? AND cc.marketing_blocked_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM message_templates t WHERE t.workspace_id=cc.workspace_id AND t.channel_id=cc.channel_id AND t.name_human=? AND t.language_code=? AND t.category='marketing')`)
    .bind(workspaceId, connectionId, externalUserId, message.templateId, message.params.language_code ?? '').first()
}
