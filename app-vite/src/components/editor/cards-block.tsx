import { useId, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Image, Plus, Settings2, Trash2 } from 'lucide-react'
import type { Connection } from '@/data/connections'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cardsError, isCards, mergeLeadText, type CardsBlock, type CardsProfile } from '../../../../engine/src/schemas/message-cards'
import type { Card } from '../../../../engine/src/schemas/message-cards'
export { isCards, cardsError, cardTexts, mergeLeadText } from '../../../../engine/src/schemas/message-cards'
/** What a connection would refuse in this card or gallery. Where a gallery is a carousel, the text block right before it is its opening message. */
export function cardsIssue(block: CardsBlock, siblings: object[], profiles: CardsProfile[]): string | undefined {
  if (!profiles.length) return cardsError(block, profiles)
  for (const profile of profiles) {
    const own = mergeLeadText(siblings, profile).find(b => isCards(b) && b.cards === block.cards)
    const error = cardsError(isCards(own) ? own : block, [profile])
    if (error) return error
  }
}
export const cardsProfiles = (connections: Connection[]) => connections.map(c => ({ cards: c.profile?.cards ?? null, buttons: c.profile?.buttons ?? { types: [], maxPerMessage: 0, titleMax: 0, payloadMaxBytes: 0 } }))

const ratioClass = (block: CardsBlock) => block.aspectRatio === 'square' ? 'aspect-square' : 'aspect-[1.91/1]'
const hasImage = (c: Card) => !!c.imageUrl && !c.imageUrl.includes('{{')

/** Prévia só de leitura (nó do mapa, celular, prévia da automação): carrossel horizontal; o link do card não aparece, só título, subtítulo e botões. */
export function CardsPreview({ block }: { block: CardsBlock }) {
  const track = useRef<HTMLDivElement>(null), [at, setAt] = useState(0)
  const many = block.cards.length > 1
  const go = (to: number) => { const el = track.current; if (!el) return; const next = Math.min(block.cards.length - 1, Math.max(0, to)); el.scrollTo({ left: next * (el.firstElementChild as HTMLElement).offsetWidth, behavior: 'smooth' }); setAt(next) }
  return <div className="space-y-1" aria-label={block.kind === 'card' ? 'Prévia do card' : 'Prévia da galeria'}>
    <div ref={track} className="nowheel flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1" onScroll={e => { const el = e.currentTarget, w = (el.firstElementChild as HTMLElement | null)?.offsetWidth; if (w) setAt(Math.round(el.scrollLeft / w)) }}>
      {block.cards.map((c, i) => <article key={i} className={`min-w-0 shrink-0 snap-start overflow-hidden rounded-lg border border-border bg-surface ${many ? 'basis-[85%]' : 'basis-full'}`}>
        {hasImage(c) ? <img src={c.imageUrl} alt={`Imagem do card ${i + 1}`} className={`w-full object-cover ${ratioClass(block)}`} /> : <div className={`grid place-items-center bg-surface-muted text-text-muted ${ratioClass(block)}`}><Image className="size-8" aria-hidden="true" /></div>}
        <div className="space-y-1 p-3"><p className="break-words font-semibold">{c.title || 'Título do card'}</p>{c.subtitle ? <p className="whitespace-pre-wrap break-words text-xs text-text-muted">{c.subtitle}</p> : null}</div>
        {c.buttons?.map((b, j) => <p key={j} className="border-t border-border px-3 py-2 text-center text-xs font-semibold text-accent">{b.title || 'Título do botão'}</p>)}
      </article>)}
    </div>
    {many ? <div className="flex items-center justify-between text-xs text-text-muted">
      <button type="button" aria-label="Card anterior" disabled={at === 0} className="nodrag grid size-6 place-items-center rounded-md hover:bg-surface-muted disabled:opacity-40" onClick={() => go(at - 1)}><ChevronLeft className="size-4" aria-hidden="true" /></button>
      <span aria-live="polite" className="tabular-nums">Card {at + 1} de {block.cards.length}</span>
      <button type="button" aria-label="Próximo card" disabled={at >= block.cards.length - 1} className="nodrag grid size-6 place-items-center rounded-md hover:bg-surface-muted disabled:opacity-40" onClick={() => go(at + 1)}><ChevronRight className="size-4" aria-hidden="true" /></button>
    </div> : null}
  </div>
}

const bare = 'w-full rounded-sm border border-transparent bg-transparent px-1 py-0.5 hover:border-border-input focus:border-border-input'

/** Editor: o próprio cartão de prévia é o formulário (imagem, título, subtítulo, botões). Link do card e dos botões ficam na configuração do toque. */
export function CardsEditor({ block, siblings, disabled, connections, onChange }: { block: CardsBlock; siblings: object[]; disabled: boolean; connections: Connection[]; onChange: (b: CardsBlock) => void }) {
  const id = useId(), profiles = cardsProfiles(connections)
  const [imageOpen, setImageOpen] = useState<number | null>(null), [touch, setTouch] = useState<string | null>(null)
  const max = Math.min(block.kind === 'card' ? 1 : 10, ...profiles.map(p => p.cards?.maxCards ?? 0))
  const maxButtons = Math.min(3, ...profiles.map(p => p.cards?.maxButtons ?? 0))
  const issue = cardsIssue(block, siblings, profiles)
  const change = (i: number, patch: Partial<Card>) => onChange({ ...block, cards: block.cards.map((c, j) => i === j ? { ...c, ...patch } : c) })
  const move = (i: number, offset: number) => { const cards = [...block.cards]; [cards[i], cards[i + offset]] = [cards[i + offset], cards[i]]; onChange({ ...block, cards }) }
  const toggle = (key: string) => setTouch(t => t === key ? null : key)
  return <div className="space-y-3">
    <div role="radiogroup" aria-label="Proporção da imagem" className="flex gap-1 text-xs">
      {([['horizontal', 'Horizontal'], ['square', 'Quadrada']] as const).map(([value, name]) => <button key={value} type="button" role="radio" aria-checked={block.aspectRatio === value} disabled={disabled} className="rounded-md border border-border px-2 py-1 font-semibold aria-checked:border-accent aria-checked:text-accent" onClick={() => onChange({ ...block, aspectRatio: value })}>{name}</button>)}
    </div>
    <ol aria-label="Cards da vitrine" className="flex snap-x snap-mandatory gap-2 overflow-x-auto pb-2">
      {block.cards.map((c, i) => <li key={i} className={`min-w-0 shrink-0 snap-start space-y-1 ${block.kind === 'gallery' ? 'basis-[88%]' : 'basis-full'}`}>
        <div className="flex items-center gap-1"><h4 className="mr-auto text-xs font-semibold">Card {i + 1}</h4>
          <Button variant="ghost" size="sm" aria-label={`Configurar toque do card ${i + 1}`} aria-expanded={touch === `c${i}`} onClick={() => toggle(`c${i}`)}><Settings2 className="size-4" aria-hidden="true" /></Button>
          {block.kind === 'gallery' ? <><Button variant="ghost" size="sm" aria-label={`Mover card ${i + 1} para trás`} disabled={disabled || i === 0} onClick={() => move(i, -1)}><ArrowLeft className="size-4" /></Button><Button variant="ghost" size="sm" aria-label={`Mover card ${i + 1} para frente`} disabled={disabled || i === block.cards.length - 1} onClick={() => move(i, 1)}><ArrowRight className="size-4" /></Button><Button variant="ghost" size="sm" aria-label={`Remover card ${i + 1}`} disabled={disabled || block.cards.length === 1} onClick={() => onChange({ ...block, cards: block.cards.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button></> : null}
        </div>
        <article className="overflow-hidden rounded-lg border border-border bg-surface">
          <button type="button" aria-label={`Imagem do card ${i + 1}`} aria-expanded={imageOpen === i} disabled={disabled} className={`relative block w-full overflow-hidden bg-surface-muted ${ratioClass(block)}`} onClick={() => setImageOpen(o => o === i ? null : i)}>
            {hasImage(c) ? <img src={c.imageUrl} alt="" className="size-full object-cover" /> : <span className="grid size-full place-items-center text-text-muted"><span className="flex flex-col items-center gap-1 text-xs font-semibold"><Image className="size-8" aria-hidden="true" />Enviar imagem</span></span>}
          </button>
          {imageOpen === i ? <div className="space-y-1 border-b border-border p-2"><Label htmlFor={`${id}-${i}-image`}>Imagem do card {i + 1} (URL)</Label><Input id={`${id}-${i}-image`} value={c.imageUrl ?? ''} disabled={disabled} placeholder="https://" onChange={e => change(i, { imageUrl: e.target.value })} /></div> : null}
          <div className="space-y-1 p-2">
            <Input aria-label={`Título do card ${i + 1}`} className={`${bare} font-semibold`} placeholder="Título do card" value={c.title} disabled={disabled} onChange={e => change(i, { title: e.target.value })} />
            <Textarea aria-label={`Subtítulo do card ${i + 1}`} className={`${bare} min-h-0 text-xs`} placeholder="Subtítulo" value={c.subtitle ?? ''} disabled={disabled} onChange={e => change(i, { subtitle: e.target.value })} />
          </div>
          {touch === `c${i}` ? <div className="space-y-1 border-t border-border p-2"><Label htmlFor={`${id}-${i}-url`}>Link ao tocar no card {i + 1}</Label><Input id={`${id}-${i}-url`} value={c.actionUrl ?? ''} disabled={disabled} placeholder="https://" onChange={e => change(i, { actionUrl: e.target.value })} /></div> : null}
          {(c.buttons ?? []).map((b, j) => <div key={j} className="border-t border-border">
            <div className="flex items-center gap-1 px-2 py-1"><Input aria-label={`Título do botão ${j + 1} do card ${i + 1}`} className={`${bare} text-center text-xs font-semibold text-accent`} placeholder="Título do botão" value={b.title} disabled={disabled} onChange={e => change(i, { buttons: c.buttons!.map((b, k) => j === k ? { ...b, title: e.target.value } : b) })} />
              <Button variant="ghost" size="sm" aria-label={`Configurar toque do botão ${j + 1} do card ${i + 1}`} aria-expanded={touch === `b${i}-${j}`} onClick={() => toggle(`b${i}-${j}`)}><Settings2 className="size-4" aria-hidden="true" /></Button>
              <Button variant="ghost" size="sm" aria-label={`Remover botão ${j + 1} do card ${i + 1}`} disabled={disabled} onClick={() => change(i, { buttons: c.buttons!.filter((_, k) => k !== j) })}><Trash2 className="size-4" aria-hidden="true" /></Button></div>
            {touch === `b${i}-${j}` ? <div className="space-y-1 px-2 pb-2">{b.type === 'url' ? <><Label htmlFor={`${id}-${i}-${j}-url`}>Link do botão {j + 1} do card {i + 1}</Label><Input id={`${id}-${i}-${j}-url`} value={b.url} disabled={disabled} placeholder="https://" onChange={e => change(i, { buttons: c.buttons!.map((b, k) => j === k ? { ...b, type: 'url', url: e.target.value } : b) })} /></> : <p className="text-xs text-text-muted">{b.type === 'call' ? `Ligar para ${b.phone}` : `Identificador: ${b.id}`}</p>}</div> : null}
          </div>)}
        </article>
        <Button size="sm" variant="secondary" disabled={disabled || (c.buttons?.length ?? 0) >= maxButtons} onClick={() => change(i, { buttons: [...(c.buttons ?? []), { type: 'url', title: '', url: '' }] })}><Plus className="size-4" />Adicionar botão ao card {i + 1}</Button>
      </li>)}
    </ol>
    {block.kind === 'gallery' ? <Button size="sm" variant="secondary" disabled={disabled || block.cards.length >= max} onClick={() => onChange({ ...block, cards: [...block.cards, { title: '' }] })}><Plus className="size-4" />Adicionar card ({block.cards.length}/{max})</Button> : null}
    {issue ? <p role="status" className="text-xs text-danger">{issue}</p> : null}
  </div>
}
