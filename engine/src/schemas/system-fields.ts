import { channelKinds, type ChannelType } from '../channels/kinds'
/** Dados de sistema que a condição do fluxo e o filtro de segmentos compartilham: uma regra só, dois lugares. */
export const emailSystemFields = ['email', 'email_opens', 'email_clicks', 'email_last_opened_at', 'email_last_clicked_at', 'email_opted_in', 'ad_source_id', 'ad_headline', 'ad_click_id', 'ad_referred_at'] as const
/** Filtro de contatos por e-mail (`email_filter` da lista de contatos e das audiências). Mora aqui, e não em email-channel/filters (que puxa o banco), porque o contrato que o painel lê usa o tipo. */
export const emailFilters = ['defined', 'undefined', 'opened', 'clicked', 'opened_clicked', 'opened_not_clicked', 'not_opened', 'subscribed', 'unsubscribed'] as const
export type EmailFilter = typeof emailFilters[number]
/** Texto do contato guardado na própria linha dele: dado -> coluna de contacts. */
export const contactTextFields = { phone: 'phone', locale: 'locale', timezone: 'timezone', last_input_text: 'last_input_text', contact_id: 'id' } as const
export type ContactTextField = keyof typeof contactTextFields
/** Dados de perfil que o provedor do canal informa e que ficam no vínculo do contato com o canal (contact_channels.channel_fields / username). */
export const channelProfileFields = {
  channel_follows_business: { kind: 'boolean', key: 'follows_business' }, channel_verified: { kind: 'boolean', key: 'verified' },
  channel_follower_count: { kind: 'number', key: 'follower_count' }, channel_username: { kind: 'text', key: 'username' },
} as const
export type ChannelProfileField = keyof typeof channelProfileFields
/** Dados do contato que o filtro de contatos já sabe comparar: a condição repassa a regra para ele em vez de duplicá-la. */
export const contactFilterFields = ['first_name', 'last_name', 'status', 'gender', 'last_interaction_at'] as const
export type ContactFilterField = typeof contactFilterFields[number]
/** "Autorizou" por canal: contato inscrito com recebimento autorizado em alguma conexão daquele canal. */
export const optInFields: Record<string, ChannelType> = Object.fromEntries(channelKinds.filter(kind => kind !== 'email').map(kind => [`opt_in_${kind}`, kind]))
/** Janela de resposta aberta em alguma conexão do contato. */
export const windowFields = ['window_open'] as const
export const extendedSystemFields: string[] = [...Object.keys(channelProfileFields), ...contactFilterFields, ...Object.keys(optInFields), ...windowFields]
export const systemConditionFields = [...emailSystemFields, ...(Object.keys(contactTextFields) as ContactTextField[]), ...extendedSystemFields] as [string, ...string[]]
export const systemConditionOperators = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'is_set', 'is_not_set', 'gt', 'gte', 'lt', 'lte', 'within_days'] as const
/** O que cada dado de texto aceita. Telefone guarda só dígitos; o ID é exato; os demais ignoram maiúsculas. */
export const textFieldOperators: Record<ContactTextField, readonly string[]> = {
  phone: ['is_set', 'is_not_set', 'starts_with', 'equals', 'not_equals'],
  locale: ['equals', 'not_equals', 'is_set', 'is_not_set'],
  timezone: ['equals', 'not_equals', 'is_set', 'is_not_set'],
  last_input_text: ['contains', 'not_contains', 'is_set', 'is_not_set'],
  contact_id: ['equals', 'not_equals'],
}
