import { z } from 'zod'

// Idiomas de P/templates/supported-languages.md (111 códigos; coletado em 2026-10-25).
export const templateLanguages = ['af','sq','ar','ar_EG','ar_AE','ar_LB','ar_MA','ar_QA','az','be_BY','bn','bn_IN','bg','ca','zh_CN','zh_HK','zh_TW','hr','cs','da','prs_AF','nl','nl_BE','en','en_GB','en_US','en_AE','en_AU','en_CA','en_GH','en_IE','en_IN','en_JM','en_MY','en_NZ','en_QA','en_SG','en_UG','en_ZA','et','fil','fi','fr','fr_BE','fr_CA','fr_CH','fr_CI','fr_MA','ka','de','de_AT','de_CH','el','gu','ha','he','hi','hu','id','ga','it','ja','kn','kk','rw_RW','ko','ky_KG','lo','lv','lt','mk','ms','ml','mr','nb','ps_AF','fa','pl','pt_BR','pt_PT','pa','ro','ru','sr','si_LK','sk','sl','es','es_AR','es_CL','es_CO','es_CR','es_DO','es_EC','es_HN','es_MX','es_PA','es_PE','es_ES','es_UY','sw','sv','ta','te','th','tr','uk','ur','uz','vi','zu'] as const
const shortText = z.string().trim().min(1).regex(/^[^\r\n\t`*~\p{Extended_Pictographic}]+$/u, 'Use texto sem emoji, formatação ou quebra de linha.')
const webUrl = (text: string) => { try { const u = new URL(text); return ['https:','http:'].includes(u.protocol) && !!u.hostname && !u.username && !u.password && !/(^|\.)wa\.me$/i.test(u.hostname) } catch { return false } }
export const variables = (text: string) => [...new Set(Array.from(text.matchAll(/\{\{([a-z][a-z_]*|[1-9]\d*)\}\}/g), m => m[1]))]
function placeholders(text: string) {
  if (/[{}]/.test(text.replace(/\{\{([a-z][a-z_]*|[1-9]\d*)\}\}/g,''))) return false
  const keys = variables(text), numeric = keys.filter(k => /^\d+$/.test(k))
  return !numeric.length || (numeric.length === keys.length && numeric.map(Number).sort((a,b)=>a-b).every((n,i)=>n===i+1))
}
export const templateDraftSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/, 'Use letras minúsculas sem acento, números e sublinhado.'),
  category: z.enum(['utility','marketing']), language: z.enum(templateLanguages),
  header: z.object({ type: z.enum(['none','text','image','video','document']), text: shortText.max(60).optional(), mediaUrl: z.string().max(2000).optional(), example: z.string().trim().min(1).max(1024).optional() }).strict(),
  body: z.string().trim().min(1).max(1024), examples: z.record(z.string().max(64), z.string().trim().max(1024)), footer: z.string().max(60).regex(/^[^{}\r\n\t`*~\p{Extended_Pictographic}]*$/u, 'Rodapé sem variáveis, emoji ou formatação.'),
  buttons: z.array(z.object({ type: z.enum(['url','reply']), text: shortText.max(25), url: z.string().max(2000).optional(), example: z.string().max(2000).optional() }).strict()).max(10),
}).strict().superRefine((d, ctx) => {
  const error = (path: (string|number)[], message: string) => ctx.addIssue({ code:'custom', path, message })
  if (!placeholders(d.body) || /^\{\{|\}\}$/.test(d.body) || /\}\}\s*\{\{/.test(d.body) || /\t|\n\n\n| {5}/.test(d.body)) error(['body'],'Revise variáveis, sequência e espaçamento do corpo; não comece nem termine com variável.')
  for (const key of variables(d.body)) if (!Object.hasOwn(d.examples,key) || typeof d.examples[key] !== 'string' || !d.examples[key].trim()) error(['examples',key],`Preencha o exemplo da variável ${key}.`)
  if (d.header.type === 'text') {
    const text = d.header.text ?? ''
    if (!text || !placeholders(text) || variables(text).length > 1) error(['header','text'],'Cabeçalho de texto obrigatório, com até uma variável.')
    if (variables(text).length && !d.header.example) error(['header','example'],'Preencha o exemplo do cabeçalho.')
  // O identificador de exemplo da Meta (Resumable Upload) é opcional: sem ele, o envio para revisão sobe a mídia do endereço e usa o identificador devolvido.
  } else if (d.header.type !== 'none' && (!d.header.mediaUrl || !webUrl(d.header.mediaUrl))) error(['header','mediaUrl'],'Informe o endereço HTTP(S) da mídia do cabeçalho.')
  const allKeys=[...variables(d.body),...variables(d.header.text??'')]
  if(allKeys.some(k=>/^\d+$/.test(k)) && allKeys.some(k=>!/^\d+$/.test(k))) error(['header'],'Use o mesmo formato de variável no cabeçalho e no corpo.')
  const urls = d.buttons.filter(b=>b.type==='url')
  if (urls.length > 2) error(['buttons'],'Use no máximo dois botões de link.')
  const kinds = d.buttons.map(b=>b.type), firstReply = kinds.indexOf('reply'), lastReply = kinds.lastIndexOf('reply')
  if (firstReply >= 0 && kinds.slice(firstReply,lastReply+1).includes('url')) error(['buttons'],'Mantenha as respostas rápidas juntas, antes ou depois dos botões de link.')
  if (new Set(d.buttons.map(b=>b.text)).size !== d.buttons.length) error(['buttons'],'Os botões precisam ter textos diferentes.')
  d.buttons.forEach((b,i) => {
    if (b.type === 'reply' && (b.url || b.example)) error(['buttons',i],'Resposta não aceita endereço.')
    if (b.type !== 'url') return
    const u = b.url ?? '', keys = variables(u)
    if (!placeholders(u) || !webUrl(u.replace(/\{\{[^}]+\}\}/g,'exemplo')) || keys.length>1 || (keys.length && (!u.endsWith(`{{${keys[0]}}}`) || !b.example || !webUrl(b.example) || /[{}]/.test(b.example)))) error(['buttons',i,'url'],'Informe um link HTTP(S), sem wa.me. Variável só no final e com URL de exemplo completa.')
  })
})
export type TemplateDraft = z.infer<typeof templateDraftSchema>
