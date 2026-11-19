import type { EditorField } from './graph'

export const emailFilters = [
  { id:'defined', name:'E-mail definido' }, { id:'undefined', name:'E-mail não definido' },
  { id:'opened', name:'Abriu um e-mail' }, { id:'clicked', name:'Clicou em um e-mail' },
  { id:'opened_clicked', name:'Abriu e clicou' },
  { id:'opened_not_clicked', name:'Abriu e não clicou' }, { id:'not_opened', name:'Ainda não abriu' },
  { id:'subscribed', name:'Inscrito em e-mail' }, { id:'unsubscribed', name:'Descadastrado do e-mail' },
] as const
export type EmailFilter = typeof emailFilters[number]['id']
export const emailSystemFields = [
  {id:'email',name:'Endereço de e-mail',type:'text',scope:'contact'},
  {id:'email_opens',name:'Quantidade de aberturas',type:'number',scope:'contact'},
  {id:'email_clicks',name:'Quantidade de cliques',type:'number',scope:'contact'},
  {id:'email_last_opened_at',name:'Última abertura',type:'number',scope:'contact'},
  {id:'email_last_clicked_at',name:'Último clique',type:'number',scope:'contact'},
  {id:'email_opted_in',name:'Inscrição em e-mail',type:'boolean',scope:'contact'},
  {id:'ad_source_id',name:'ID do anúncio de origem',type:'text',scope:'contact'},
  {id:'ad_headline',name:'Título do anúncio de origem',type:'text',scope:'contact'},
  {id:'ad_click_id',name:'Código do clique do anúncio',type:'text',scope:'contact'},
  {id:'ad_referred_at',name:'Chegada pelo anúncio',type:'number',scope:'contact'},
  {id:'phone',name:'Telefone',type:'text',scope:'contact'},
  {id:'locale',name:'Idioma',type:'text',scope:'contact'},
  {id:'timezone',name:'Fuso horário',type:'text',scope:'contact'},
  {id:'last_input_text',name:'Última mensagem do contato',type:'text',scope:'contact'},
  {id:'contact_id',name:'ID do contato',type:'text',scope:'contact'},
  {id:'first_name',name:'Primeiro nome',type:'text',scope:'contact'},
  {id:'last_name',name:'Sobrenome',type:'text',scope:'contact'},
  {id:'status',name:'Situação da inscrição',type:'text',scope:'contact'},
  {id:'gender',name:'Gênero',type:'text',scope:'contact'},
  {id:'last_interaction_at',name:'Última interação',type:'number',scope:'contact'},
  {id:'window_open',name:'Janela de 24 h aberta',type:'boolean',scope:'contact'},
  {id:'channel_follows_business',name:'Está seguindo sua conta',type:'boolean',scope:'contact'},
  {id:'channel_verified',name:'Conta verificada',type:'boolean',scope:'contact'},
  {id:'channel_follower_count',name:'Número de seguidores',type:'number',scope:'contact'},
  {id:'channel_username',name:'Usuário do Instagram',type:'text',scope:'contact'},
  {id:'opt_in_instagram',name:'Autorizou receber (Instagram)',type:'boolean',scope:'contact'},
  {id:'opt_in_messenger',name:'Autorizou receber (Messenger)',type:'boolean',scope:'contact'},
  {id:'opt_in_whatsapp',name:'Autorizou receber (WhatsApp)',type:'boolean',scope:'contact'},
  {id:'opt_in_telegram',name:'Autorizou receber (Telegram)',type:'boolean',scope:'contact'},
  {id:'opt_in_tiktok',name:'Autorizou receber (TikTok)',type:'boolean',scope:'contact'},
].map((field): EditorField => ({...field,scope:'contact',type:field.type as EditorField['type'],workspace_id:'',description:null,bot_value:null,created_at:''}))

/** Dados de texto do próprio contato: cada um aceita só as comparações que fazem sentido para ele. */
export const contactTextOperators: Record<string, readonly string[]> = {
  phone: ['is_set','is_not_set','starts_with','equals','not_equals'], locale: ['equals','not_equals','is_set','is_not_set'],
  timezone: ['equals','not_equals','is_set','is_not_set'], last_input_text: ['contains','not_contains','is_set','is_not_set'], contact_id: ['equals','not_equals'],
}
/** Dados que a Condição repassa ao filtro de contatos ou ao perfil do canal: cada um aceita só o que o motor entende. */
const yesNo = ['equals','not_equals'] as const
const nameLike = ['equals','not_equals','contains','not_contains','is_set','is_not_set'] as const
export const extendedOperators: Record<string, readonly string[]> = {
  first_name: nameLike, last_name: nameLike, status: yesNo, gender: ['equals','is_set','is_not_set'], last_interaction_at: ['within_days','is_set','is_not_set'],
  window_open: yesNo, channel_follows_business: yesNo, channel_verified: yesNo, channel_username: nameLike,
  channel_follower_count: ['equals','not_equals','gt','gte','lt','lte','is_set','is_not_set'],
  opt_in_instagram: yesNo, opt_in_messenger: yesNo, opt_in_whatsapp: yesNo, opt_in_telegram: yesNo, opt_in_tiktok: yesNo,
}
/** Dados de texto com lista fechada de valores (o painel mostra uma escolha, não um campo livre). */
export const systemFieldChoices: Record<string, { id: string; name: string }[]> = {
  status: [{ id: 'subscribed', name: 'Inscrito' }, { id: 'unsubscribed', name: 'Descadastrado' }],
  gender: [{ id: 'female', name: 'Feminino' }, { id: 'male', name: 'Masculino' }, { id: 'other', name: 'Outro' }],
}
export function emailOperatorsFor(fieldId: string) {
  if(extendedOperators[fieldId]) return extendedOperators[fieldId] as readonly ('equals'|'not_equals'|'contains'|'not_contains'|'starts_with'|'is_set'|'is_not_set'|'gt'|'gte'|'lt'|'lte'|'within_days')[]
  if(contactTextOperators[fieldId]) return contactTextOperators[fieldId] as readonly string[] as readonly ('equals'|'not_equals'|'contains'|'not_contains'|'starts_with'|'is_set'|'is_not_set')[]
  const field=emailSystemFields.find(field=>field.id===fieldId)
  if(field?.type === 'text') return ['equals','not_equals','contains','is_set','is_not_set'] as const
  if(field?.type === 'boolean') return ['equals','not_equals','is_set','is_not_set'] as const
  return ['equals','not_equals','is_set','is_not_set','gt','gte','lt','lte',...(fieldId.endsWith('_at') ? ['within_days' as const] : [])] as const
}

/** Fields that hold a moment (ms): the value is a date, not a count. */
export const isDateSystemField = (id: string) => id === 'email_last_opened_at' || id === 'email_last_clicked_at' || id === 'ad_referred_at'
