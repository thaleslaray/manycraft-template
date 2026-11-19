import type { EditorField } from './graph'

export type TimeWindow = { from: string; to: string; days: number[] }
export type DateSource = { kind: 'specific'; at: string } | { kind: 'field'; field_id: string }
export type DateOffset = { value: number; unit: 'minutes' | 'hours' | 'days'; direction: 'before' | 'after' }
export type TemporalRule = { type: 'sequence'; sequence_id: string; operator: 'has' | 'not_has' }
  | { type: 'origin'; origin: string; operator: 'is' | 'is_not' }
  | { type: 'current_time'; window: TimeWindow; timezone?: string }
  | { type: 'date'; field_id: string; operator: 'before' | 'after' | 'equals'; compare: DateSource; offset?: DateOffset; timezone?: string }
export const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
export const defaultWindow: TimeWindow = { from: '08:00', to: '18:00', days: [1, 2, 3, 4, 5] }
export const defaultOffset: DateOffset = { value: 0, unit: 'days', direction: 'after' }
export const dateFields = (fields: EditorField[] = []) => fields.filter(f => f.scope === 'contact' && (f.type === 'date' || f.type === 'datetime'))
export function describeWindow(window: TimeWindow): string {
  return `${window.from}–${window.to} · ${window.days.map(d => weekdays[d]).join(', ')}`
}
export function describeDate(source?: DateSource, fields: EditorField[] = []): string {
  if (!source) return 'data a definir'
  if (source.kind === 'field') return fields.find(f => f.id === source.field_id)?.name ?? 'campo de data a definir'
  const [date, time] = source.at.split('T')
  return date ? `${date.split('-').reverse().join('/')}${time ? ` às ${time.slice(0, 5)}` : ''}` : 'data a definir'
}
export function describeOffset(offset?: DateOffset): string {
  return offset?.value ? ` · ${offset.value} ${{ minutes: 'min', hours: 'h', days: 'dias' }[offset.unit]} ${offset.direction === 'before' ? 'antes' : 'depois'}` : ''
}
export function describeSmartDelay(config: Record<string, unknown>, duration: string, fields: EditorField[] = []): string {
  const base = config.mode === 'date' ? `Aguarda até ${describeDate(config.date as DateSource, fields)}${describeOffset(config.offset as DateOffset)}` : `Aguarda ${duration}`
  return `${base}${config.window ? ` · ${describeWindow(config.window as TimeWindow)}` : ''}${config.timezone ? ` · ${config.timezone}` : ''}`
}

/** Frase do nó de Espera, como no original: "Aguarde 2 Minutos depois continue". */
export function describeWaitPhrase(config: Record<string, unknown>, duration: string, fields: EditorField[] = []): string {
  const quanto = config.mode === 'date' ? `até ${describeDate(config.date as DateSource, fields)}${describeOffset(config.offset as DateOffset)}` : duration
  return `Aguarde ${quanto} depois continue`
}

const fallbackZones = ['America/Sao_Paulo', 'America/Manaus', 'America/Fortaleza', 'America/New_York', 'Europe/Lisbon', 'Europe/London']
function allZones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  const zones = supported ? supported('timeZone') : fallbackZones
  return zones.includes('UTC') ? zones : [...zones, 'UTC']
}
const foldText = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/_/g, ' ').trim()
/** Fusos para o seletor com busca (sem acento, caixa nem sublinhado). O nome técnico fica no id. */
export function timezoneChoices(query: string): { id: string; label: string }[] {
  const q = foldText(query)
  return allZones().filter(id => !q || foldText(id).includes(q)).map(id => ({ id, label: id.replace(/_/g, ' ') }))
}

/** Origem do contato = gatilho da primeira passagem dele. Os nomes são nossos, não os do ManyChat. */
export const originOptions: { id: string; name: string }[] = [
  { id: 'keyword', name: 'Palavra-chave' }, { id: 'meta_keyword', name: 'Palavra-chave da Meta' },
  { id: 'rule', name: 'Regra' }, { id: 'external_trigger', name: 'Gatilho externo' }, { id: 'another_flow', name: 'Outra automação' },
  { id: 'default_reply', name: 'Resposta padrão' }, { id: 'welcome_message', name: 'Mensagem de boas-vindas' }, { id: 'story_mention_reply', name: 'Menção em story' },
  { id: 'ice_breaker', name: 'Quebra-gelo' }, { id: 'main_menu', name: 'Menu principal' }, { id: 'cart_reply', name: 'Resposta de carrinho' },
  { id: 'widget', name: 'Qualquer widget' }, { id: 'messenger_ref_url', name: 'Widget: link de referência' },
  { id: 'ads', name: 'Widget: anúncio' }, { id: 'feed_comment', name: 'Widget: comentário no feed' }, { id: 'feed_comment_trigger', name: 'Widget: comentário com palavra' },
  { id: 'messenger_code', name: 'Widget: código QR' }, { id: 'instagram_story_reply', name: 'Widget: resposta a story' },
  { id: 'instagram_share_to_story_reply', name: 'Widget: compartilhamento em story' }, { id: 'instagram_live_comment_reply', name: 'Widget: comentário em live' },
  { id: 'ctwa_trigger', name: 'Widget: anúncio para WhatsApp' }, { id: 'tiktok_ads_ctx', name: 'Widget: anúncio do TikTok' },
]
export const describeOrigin = (rule: { origin: string; operator: 'is' | 'is_not' }) =>
  `${rule.operator === 'is' ? 'Veio de' : 'Não veio de'} ${originOptions.find(o => o.id === rule.origin)?.name.toLowerCase() ?? 'origem indisponível'}`
