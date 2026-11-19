/** Lista de opções: regras compartilhadas pelo editor (navegador) e pelo motor.
 * Os limites de linhas, seções e textos vêm da ficha da conexão (`list`); só o que a ficha não traz fica aqui. */
export const LIST_BUTTON_TEXT_MAX = 20
export const LIST_SECTION_TITLE_MAX = 24
export const LIST_BODY_MAX = 1024

export type ListRowBlock = { id: string; title: string; description?: string }
export type ListSectionBlock = { title?: string; rows: ListRowBlock[] }
export type ListBlock = { kind: 'list'; buttonText: string; sections: ListSectionBlock[] }
export type ListLimits = { maxRows: number; maxSections: number; rowTitleMax: number; rowDescMax: number }
export type ListProfile = { list?: ListLimits | null }

export const isListBlock = (b: unknown): b is ListBlock => typeof b === 'object' && b !== null && 'kind' in b && b.kind === 'list'
export const listRows = (block: ListBlock): ListRowBlock[] => block.sections.flatMap(s => s.rows)

/** Aplica `fn` a todo texto que a pessoa lê na lista (botão, seções, linhas): é por aqui que as variáveis são preenchidas. */
export const mapListText = (block: ListBlock, fn: (text: string) => string): ListBlock => ({
  ...block, buttonText: fn(block.buttonText),
  sections: block.sections.map(s => ({ ...s, ...(s.title !== undefined ? { title: fn(s.title) } : {}),
    rows: s.rows.map(r => ({ ...r, title: fn(r.title), ...(r.description !== undefined ? { description: fn(r.description) } : {}) })) })),
})

/** O menor limite entre as conexões; null quando alguma delas não oferece lista. */
export function listLimits(profiles: ListProfile[]): ListLimits | null {
  if (!profiles.length || profiles.some(p => !p.list)) return null
  const lists = profiles.map(p => p.list!)
  return { maxRows: Math.min(...lists.map(l => l.maxRows)), maxSections: Math.min(...lists.map(l => l.maxSections)),
    rowTitleMax: Math.min(...lists.map(l => l.rowTitleMax)), rowDescMax: Math.min(...lists.map(l => l.rowDescMax)) }
}

const size = (s: unknown) => typeof s === 'string' ? [...s].length : 0

/** Mensagem inteira: a lista e o resto do bloco precisam combinar com a ficha de cada conexão. */
export function listError(blocks: { kind?: unknown; text?: unknown }[], profiles: ListProfile[]): string | undefined {
  const lists = blocks.filter(isListBlock)
  if (!lists.length) return
  if (!profiles.length) return 'Escolha uma conexão compatível no gatilho.'
  if (lists.length > 1) return 'Use só uma lista de opções por mensagem.'
  if (blocks.some(b => b.kind === 'button' || b.kind === 'quick_reply')) return 'Lista de opções não coexiste com botões nem respostas rápidas no mesmo texto.'
  const bodies = blocks.filter(b => b.kind === 'text' && typeof b.text === 'string' && b.text.trim())
  if (!bodies.length) return 'A lista de opções acompanha um texto da mensagem.'
  if (size(bodies.at(-1)!.text) > LIST_BODY_MAX) return `O texto que acompanha a lista aceita até ${LIST_BODY_MAX.toLocaleString('pt-BR')} caracteres.`
  const list = lists[0]
  if (profiles.some(p => !p.list)) return 'Esta conexão não oferece lista de opções.'
  const limits = listLimits(profiles)!
  const rows = list.sections.flatMap(s => s.rows)
  if (!list.buttonText.trim()) return 'Dê um texto ao botão que abre a lista.'
  if (size(list.buttonText) > LIST_BUTTON_TEXT_MAX) return `O texto do botão da lista aceita até ${LIST_BUTTON_TEXT_MAX} caracteres.`
  if (!list.sections.length) return 'Adicione ao menos uma opção à lista.'
  if (list.sections.length > limits.maxSections) return `Use até ${limits.maxSections} seções na lista nesta conexão.`
  if (list.sections.some(s => !s.rows.length)) return 'Toda seção da lista precisa de ao menos uma opção.'
  if (rows.length > limits.maxRows) return `Use até ${limits.maxRows} opções na lista nesta conexão.`
  if (list.sections.length > 1 && list.sections.some(s => !s.title?.trim())) return 'Dê um título a cada seção quando houver mais de uma.'
  if (list.sections.some(s => size(s.title) > LIST_SECTION_TITLE_MAX)) return `Título de seção deve ter até ${LIST_SECTION_TITLE_MAX} caracteres.`
  if (rows.some(r => !r.id || !r.title.trim())) return 'Dê um título a cada opção da lista.'
  if (rows.some(r => size(r.title) > limits.rowTitleMax)) return `Título da opção deve ter até ${limits.rowTitleMax} caracteres.`
  if (rows.some(r => size(r.description) > limits.rowDescMax)) return `Descrição da opção deve ter até ${limits.rowDescMax} caracteres.`
  if (new Set(rows.map(r => r.id)).size !== rows.length) return 'Cada opção da lista precisa de um identificador próprio.'
}
