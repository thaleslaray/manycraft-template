import { mediaUrl } from './message-media'
import { messageVariables } from './message-variables'

export type CardButton = { type: 'url'; title: string; url: string } | { type: 'postback'; title: string; id: string } | { type: 'call'; title: string; phone: string }
export type Card = { title: string; subtitle?: string; imageUrl?: string; actionUrl?: string; buttons?: CardButton[] }
export type CardsProfile = { cards: { maxCards: number; titleMax: number; subtitleMax: number; maxButtons: number; adaptation?: 'generic_template' | 'interactive_carousel' } | null; buttons: { types: CardButton['type'][]; titleMax: number; payloadMaxBytes: number; maxPerMessage: number } }
export type CardsBlock = { kind: 'card' | 'gallery'; aspectRatio: 'horizontal' | 'square'; cards: Card[] }
/** `text` is the lead message of a carousel (see `mergeLeadText`); the editor never stores it on the block. */
export type LeadCardsBlock = CardsBlock & { text?: string }
export const isCards = (b: unknown): b is CardsBlock => typeof b === 'object' && b !== null && 'kind' in b && (b.kind === 'card' || b.kind === 'gallery')
export const cardTexts = (b: CardsBlock): string[] => b.cards.flatMap(c => [c.title, c.subtitle ?? '', c.imageUrl ?? '', c.actionUrl ?? '', ...(c.buttons ?? []).flatMap(b => [b.title, b.type === 'url' ? b.url : b.type === 'postback' ? b.id : b.phone])])
export function cardsError(block: LeadCardsBlock, profiles: CardsProfile[], allowVariables = true): string | undefined {
  if (!profiles.length) return 'Escolha uma conexão compatível no gatilho.'
  // Validate the fixed URL structure too: a variable must never hide a forbidden protocol.
  // A complete URL may itself be dynamic; the runtime validates the rendered value again.
  const validUrl = (s: string) => mediaUrl(allowVariables
    ? messageVariables(s).reduce((url, variable) => url.replace(variable.raw, 'https://example.test'), s)
    : s)
  for (const profile of profiles) {
    const limits = profile.cards
    if (!limits) return `Esta conexão não oferece ${block.kind === 'card' ? 'Card' : 'Galeria'}.`
    if (limits.adaptation === 'interactive_carousel' && block.cards.length) {
      const error = carouselError(block, profile)
      if (error) return error
    }
    if (!block.cards.length || block.cards.length > Math.min(block.kind === 'card' ? 1 : 10, limits.maxCards)) return `Use de 1 a ${Math.min(block.kind === 'card' ? 1 : 10, limits.maxCards)} cards.`
    if (!['horizontal', 'square'].includes(block.aspectRatio)) return 'Escolha a proporção horizontal ou quadrada.'
    for (const c of block.cards) {
      if (!c.title.trim() || [...c.title].length > limits.titleMax) return `Preencha o título do card com até ${limits.titleMax} caracteres.`
      if ([...(c.subtitle ?? '')].length > limits.subtitleMax) return `Subtítulo acima de ${limits.subtitleMax} caracteres.`
      if (c.imageUrl && !validUrl(c.imageUrl)) return 'Informe uma URL completa para a imagem do card.'
      if (c.actionUrl && !validUrl(c.actionUrl)) return 'Informe uma URL completa para o toque no card.'
      if ((c.buttons?.length ?? 0) > Math.min(3, limits.maxButtons)) return `Use até ${Math.min(3, limits.maxButtons)} botões por card.`
      for (const b of c.buttons ?? []) {
        if (!profile.buttons.types.includes(b.type)) return 'Tipo de botão incompatível com a conexão.'
        if (!b.title.trim() || [...b.title].length > profile.buttons.titleMax) return `Título do botão deve ter até ${profile.buttons.titleMax} caracteres.`
        if (b.type === 'url' && !validUrl(b.url)) return 'Informe uma URL completa para o botão do card.'
        if (b.type === 'postback' && (!b.id || new TextEncoder().encode(b.id).length > profile.buttons.payloadMaxBytes)) return 'Identificador inválido no botão do card.'
        if (b.type === 'call' && !/^\+?\d{6,15}$/.test(b.phone)) return 'Informe um telefone válido no botão do card.'
      }
    }
  }
}
export const cardsMessage = (block: LeadCardsBlock): { kind: 'cards'; aspectRatio: 'horizontal' | 'square'; cards: Card[]; text?: string } => ({ kind: 'cards', aspectRatio: block.aspectRatio, cards: block.cards, ...(block.text ? { text: block.text } : {}) })

/** The card text the contact reads: title, then subtitle on the next line. */
export const cardBody = (c: Card) => [c.title, c.subtitle].filter(Boolean).join('\n')
const size = (s: string | undefined) => [...(s ?? '')].length
const breaks = (s: string) => s.split('\n').length - 1

/** Limits of an interactive carousel (2 to 10 cards) and of the single card that goes as a media message with buttons.
 * Source: the channel contract (replica/contratos, limites.md) (Carrossel interativo, CTA URL, botões de resposta, legenda de mídia).
 * The page does not say how many quick replies a carousel card takes; 2 is the only evidenced number (the example, and the template carousel). */
function carouselError(block: LeadCardsBlock, profile: CardsProfile): string | undefined {
  const cards = block.cards
  const buttonsOf = (c: Card) => c.buttons ?? []
  if (cards.some(c => c.actionUrl)) return 'Nesta conexão o toque no card não existe: tire o link do card e use um botão de link.'
  if (cards.some(c => buttonsOf(c).some(b => b.type === 'call'))) return 'Nesta conexão o card não tem botão de ligar: use um botão de link ou botões de resposta.'
  for (const c of cards) {
    const links = buttonsOf(c).filter(b => b.type === 'url').length
    if (links > 1) return 'Cada card desta conexão aceita um único botão de link.'
    if (links && buttonsOf(c).length > links) return 'Cada card desta conexão usa um botão de link ou botões de resposta, nunca os dois juntos.'
  }
  if (cards.length === 1) {
    const c = cards[0], buttons = buttonsOf(c)
    if (size(cardBody(c)) > 1024) return 'Nesta conexão o texto do card (título mais subtítulo) aceita até 1.024 caracteres.'
    if (buttons.filter(b => b.type === 'postback').length > profile.buttons.maxPerMessage) return `Nesta conexão um card sozinho aceita até ${profile.buttons.maxPerMessage} botões de resposta.`
    const titles = buttons.map(b => b.title)
    if (new Set(titles).size !== titles.length) return 'Os botões do mesmo card precisam ter títulos diferentes.'
    return
  }
  if (cards.length < 2 || cards.length > 10) return 'O carrossel desta conexão precisa de 2 a 10 cards.'
  if (!block.text?.trim()) return 'O carrossel desta conexão precisa de um texto de abertura: coloque uma mensagem de texto logo antes da galeria.'
  if (size(block.text) > 1024) return 'O texto de abertura do carrossel desta conexão aceita até 1.024 caracteres.'
  if (cards.some(c => !c.imageUrl?.trim())) return 'Todo card do carrossel desta conexão precisa de imagem.'
  if (cards.some(c => !buttonsOf(c).length)) return 'Todo card do carrossel desta conexão precisa de um botão de link ou de pelo menos um botão de resposta.'
  const shape = (c: Card) => buttonsOf(c)[0].type === 'url' ? 'url' : `reply:${buttonsOf(c).length}`
  if (new Set(cards.map(shape)).size > 1) return 'Todos os cards do carrossel desta conexão precisam ter os mesmos botões: o mesmo tipo e a mesma quantidade.'
  if (cards.some(c => buttonsOf(c).length > 2)) return 'Cada card do carrossel desta conexão aceita até 2 botões de resposta.'
  if (cards.some(c => size(cardBody(c)) > 160 || breaks(cardBody(c)) > 2)) return 'O texto de cada card do carrossel desta conexão aceita até 160 caracteres e 2 quebras de linha.'
  if (cards.some(c => buttonsOf(c).some(b => size(b.title) > 20))) return 'O botão do card do carrossel desta conexão aceita até 20 caracteres.'
  for (const c of cards) {
    const titles = buttonsOf(c).map(b => b.title)
    if (new Set(titles).size !== titles.length) return 'Os botões do mesmo card precisam ter títulos diferentes.'
  }
  const ids = cards.flatMap(c => buttonsOf(c).flatMap(b => b.type === 'postback' ? [b.id] : []))
  if (new Set(ids).size !== ids.length || ids.some(id => id.trim() !== id)) return 'Os identificadores dos botões de resposta do carrossel precisam ser diferentes e sem espaços nas pontas.'
}

/** A carousel needs a lead message (the main body). Where the profile says so, the text block right before a gallery of 2 or more cards
 * becomes that lead: it is consumed (so it is not sent twice) and carried on the cards block. Buttons in between do not break the adjacency. */
export function mergeLeadText<B extends object>(blocks: B[], profile: Pick<CardsProfile, 'cards'>): B[] {
  if (profile.cards?.adaptation !== 'interactive_carousel') return blocks
  const out: B[] = []
  for (const block of blocks) {
    if (isCards(block) && block.cards.length > 1 && !(block as LeadCardsBlock).text) {
      let at = out.length - 1
      const kindOf = (b: B) => (b as { kind?: unknown }).kind
      while (at >= 0 && (kindOf(out[at]) === 'button' || kindOf(out[at]) === 'quick_reply')) at--
      const before = out[at] as unknown as { kind: string; text?: string } | undefined
      if (before?.kind === 'text' && typeof before.text === 'string' && before.text.trim()) {
        out.splice(at, 1)
        out.push({ ...block, text: before.text } as B)
        continue
      }
    }
    out.push(block)
  }
  return out
}
