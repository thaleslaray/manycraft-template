import { apiRequest } from './api'
export type EmailSender = { id: string; address: string; name: string; replyTo: string; branding: boolean; isDefault: boolean; status: string; domain: string; verificationExpiresAt?: string | number; dns: { type: string; name: string; value: string }[] }
export type EmailSettings = { defaultSenderId: string | null; senders: EmailSender[]; usage: { sent: number; paused: boolean; pauseReason?: 'bounce' | 'unsubscribe' | 'complaint' | 'provider' | 'manual' | null }; company: { name: string; address: string } }
export type EmailDesign = { subject: string; subTitle: string; content: Record<string, unknown> }
export type EmailEventAction = { type: 'add_tag' | 'remove_tag'; tag_id: string }
export type EmailDraft = { id?: string; name: string; senderId: string; subject: string; preheader: string; text: string; html: string; design: EmailDesign; onOpen?: { mode: 'once' | 'every'; automationId?: string; actions?: EmailEventAction[] }; linkActions?: { url: string; automationId?: string; actions?: EmailEventAction[] }[] }
export const getEmailSettings = () => apiRequest<EmailSettings>('/email/settings')
export const saveEmailSender = (input: Partial<Pick<EmailSender, 'address' | 'name' | 'replyTo' | 'branding'>>, id?: string) => apiRequest<EmailSender>(`/email/senders${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PATCH' : 'POST', body: JSON.stringify({ ...input, ...(id ? { address: undefined } : {}), ...(!input.replyTo ? { replyTo: undefined } : {}) }) })
export const updateEmailSettings = (input: Partial<Pick<EmailSettings, 'defaultSenderId' | 'company'>> & { paused?: boolean }) => apiRequest('/email/settings', { method: 'PATCH', body: JSON.stringify(input) })
export const verifyEmailSender = (id: string, input: { stage?: 'address' | 'dns' | 'resend'; warmupAccepted?: boolean } = {}) => apiRequest<EmailSender>(`/email/senders/${encodeURIComponent(id)}/verify`, { method: 'POST', body: JSON.stringify(input) })
export const getEmailDrafts = () => apiRequest<EmailDraft[]>('/email/drafts')
export const saveEmailDraft = (input: EmailDraft) => apiRequest<EmailDraft>('/email/drafts', { method: 'POST', body: JSON.stringify(input) })
export const sendEmailTest = (input: Omit<EmailDraft, 'name'> & { to: string }) => apiRequest<{ simulated?: boolean; contactId?: string; conversationId?: string }>('/email/test', { method: 'POST', body: JSON.stringify({ ...input, consent: true }) })
export const attachEmailDraftToAutomation = (draftId: string, automationId: string, nodeId: string) => apiRequest(`/email/drafts/${encodeURIComponent(draftId)}/automation-node`, { method: 'POST', body: JSON.stringify({ automationId, nodeId }) })
export type EmailContactProfile = { channels: { id: string; channel_id: string; address: string; optedIn: number | boolean }[]; metrics: { opens: number; clicks: number; lastOpenedAt: number | null; lastClickedAt: number | null }; segment: 'opened_clicked' | 'opened_not_clicked' | 'not_opened' }
export type EmailMetrics = { sent: number; delivered: number; opened: number; clicked: number; ctr: number; definitions: { delivered: string; opened: string } }
export const getEmailContact = (contactId: string) => apiRequest<EmailContactProfile>(`/email/contacts/${encodeURIComponent(contactId)}`)
export const updateEmailContact = (contactId: string, input: { address?: string; optedIn?: boolean; consent?: boolean }) => apiRequest(`/email/contacts/${encodeURIComponent(contactId)}`, { method: 'PATCH', body: JSON.stringify(input) })
export const getEmailMetrics = () => apiRequest<EmailMetrics>('/email/metrics')

/** Por que os envios pararam e o que fazer antes de retomar. */
export const emailPauseNotice = (reason: EmailSettings['usage']['pauseReason']) =>
  reason === 'bounce' ? 'Envios pausados: muitos e-mails voltaram (endereços que não existem ou caixas cheias). Limpe a lista antes de retomar.'
  : reason === 'unsubscribe' ? 'Envios pausados: muita gente se descadastrou nos últimos 30 dias. Revise para quem e o que você envia antes de retomar.'
  : reason === 'complaint' ? 'Envios pausados: houve marcações de spam acima do limite. Envie só para quem pediu para receber antes de retomar.'
  : reason === 'provider' ? 'Envios pausados: o serviço de envio suspendeu a conta por reputação. Retomar aqui não basta enquanto a suspensão durar.'
  : reason === 'manual' ? 'Envios pausados por alguém da equipe.'
  : 'Envios pausados. O motivo não ficou registrado.'
