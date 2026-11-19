import { apiRequest } from './api'
import { templateDraftSchema, variables, templateLanguages, type TemplateDraft } from '../../../engine/src/channels/template-draft'
export { variables, templateLanguages, templateDraftSchema }
export type { TemplateDraft }
export type MessageTemplate = TemplateDraft & { id:string; status:string; quality:string; submittedAt:number|null; syncedAt:number|null; rejectionReason:string|null; unavailableReason:string|null }
export type TemplateOptions = { canEdit:boolean; connections:{ id:string; label:string; canSync:boolean }[] }
const path=(connection:string)=>`/message-templates/${encodeURIComponent(connection)}`
export const templateOptions=()=>apiRequest<TemplateOptions>('/message-templates/options')
export const listTemplates=(connection:string)=>apiRequest<MessageTemplate[]>(path(connection))
export const saveTemplate=(connection:string,draft:TemplateDraft,id?:string)=>apiRequest<MessageTemplate>(`${path(connection)}${id?`/${encodeURIComponent(id)}`:''}`,{method:id?'PATCH':'POST',body:JSON.stringify(draft)})
export const submitTemplate=(connection:string,id:string)=>apiRequest<MessageTemplate>(`${path(connection)}/${encodeURIComponent(id)}/submit`,{method:'POST'})
export const syncTemplates=(connection:string)=>apiRequest(`${path(connection)}/sync`,{method:'POST'})
