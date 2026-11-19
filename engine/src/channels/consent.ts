/** Coleta com opt-in: canais que cada campo do sistema pode autorizar (o e-mail autoriza e-mail; o telefone, WhatsApp). */
export const consentChannels = ['email', 'whatsapp'] as const
export const consentChannelsByField: Record<string, readonly (typeof consentChannels)[number][]> = { 'system:email': ['email'], 'system:phone': ['whatsapp'] }
/** API pública: bandeiras de opt-in no cadastro de contato -> canal que autorizam (exigem consent_phrase). */
export const apiOptInFlags = { has_opt_in_email: 'email' } as const
