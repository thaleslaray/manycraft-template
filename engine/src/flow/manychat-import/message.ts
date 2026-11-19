import { translateVariables, type VarHooks } from './vars'
import { isManychatMediaUrl, type MediaCopy, type MediaResolver } from './media'
import type { J, RefResolver } from './types'

const unitsOk = new Set(['seconds', 'minutes', 'hours', 'days'])
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
export function durationOf(raw: J | null | undefined, fallback: { value: number; unit: string }) {
  const value = Math.floor(Number(raw?.value))
  return raw && Number.isFinite(value) && value >= 1 && unitsOk.has(String(raw.unit)) ? { value, unit: String(raw.unit) } : fallback
}

export type MessageSeg = {
  blocks: J[]
  /** porta do botão/resposta -> id do destino na ManyChat */
  ports: [string, string][]
  /** rótulos de blocos que não entraram */
  dropped: string[]
  media: string[]
  notes: { level: 'loss' | 'attention'; code: string; message: string }[]
  clickTimeout?: { value: number; unit: string }
  replyAttempts?: number
}
export type BlockContext = { byId: Map<string, J>; buttons: Map<string, J>; templates: Map<string, { body: string }>; refs: RefResolver; hooks: VarHooks; media?: MediaResolver }

/** Mídia da ManyChat: registra o endereço e devolve a cópia nossa quando já existe; falha vira pendência e o endereço original fica. */
function copyOf(seg: MessageSeg, url: string, ctx: BlockContext): MediaCopy | undefined {
  if (!isManychatMediaUrl(url)) return undefined
  seg.media.push(url)
  const result = ctx.media?.(url)
  if (!result) return undefined
  if ('error' in result) {
    seg.notes.push({ level: 'attention', code: 'media_download_failed', message: `Mídia “${new URL(url).pathname.split('/').pop()}” não foi copiada (${result.error}); o passo ainda aponta para o endereço da ManyChat.` })
    return undefined
  }
  return result
}

/** Converte um bloco interno da ManyChat em blocos de mensagem nossos. Retorna sem erro: o que não cabe vai para `dropped`. */
export function addBlock(seg: MessageSeg, block: J, ctx: BlockContext, topLevel = true) {
  const text = (value: unknown) => translateVariables(String(value ?? ''), ctx.hooks)
  const addButtons = (ids: unknown) => {
    for (const id of (Array.isArray(ids) ? ids : []) as string[]) {
      const b = ctx.buttons.get(id)
      if (!b) continue
      if (b.type === 'content') {
        seg.blocks.push({ kind: 'button', id: b.id, label: text(b.caption) || 'Botão', action: { type: 'go_to_node' } })
        if (b.targetId) seg.ports.push([`btn:${b.id}`, b.targetId])
      } else if (b.type === 'url' || b.type === 'cta_url') {
        seg.blocks.push({ kind: 'button', id: b.id, label: text(b.caption) || 'Botão', action: { type: 'url', url: text(b.url) } })
        if (b.targetId) seg.ports.push([`btn:${b.id}`, b.targetId])
      } else seg.dropped.push(`button:${b.type}`)
    }
  }
  switch (block.type) {
    case 'text': {
      const value = text(block.text)
      if (value.trim()) seg.blocks.push({ kind: 'text', text: value })
      addButtons(block.buttons)
      return
    }
    case 'quick_reply': {
      const replies = ((block.buttons ?? []) as string[]).map(id => ctx.buttons.get(id)).filter((b): b is J => !!b && b.type === 'content')
      for (const b of replies) {
        seg.blocks.push({ kind: 'quick_reply', id: b.id, label: text(b.caption) || 'Opção' })
        if (b.targetId) seg.ports.push([`btn:${b.id}`, b.targetId])
      }
      const settings = block.settings ?? {}
      if (replies.length && settings.skipButtonCaption) {
        seg.blocks.push({ kind: 'quick_reply', id: `${block.id}~skip`, label: 'Pular', skip: true })
        seg.notes.push({ level: 'attention', code: 'skip_caption', message: 'Botão de pular: o rótulo agora é sempre “Pular”.' })
      }
      if (replies.length && settings.timeout) seg.clickTimeout = durationOf(settings.timeout, { value: 24, unit: 'hours' })
      if (replies.length && settings.answerRetries > 0) seg.replyAttempts = clamp(Math.floor(settings.answerRetries), 1, 5)
      return
    }
    case 'delay': {
      for (let left = Math.floor(Number(block.time) || 0); left > 0; left -= 10) seg.blocks.push({ kind: 'typing', seconds: Math.min(10, left) })
      return
    }
    case 'attachment': {
      const a = block.attachment ?? {}
      const url = a.image_url ?? a.gif ?? a.file ?? a.img_big
      const mime = String(a.mime ?? '')
      const media = block.attachmentType === 'image' ? 'image' : block.attachmentType === 'video' ? 'video' : block.attachmentType === 'audio' || mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'file'
      if (typeof url !== 'string' || !url) { seg.dropped.push('block:attachment'); return }
      const link = text(url)
      const copy = copyOf(seg, link, ctx)
      seg.blocks.push({ kind: 'media', media, url: copy?.url ?? link, ...(copy ? { mediaId: copy.mediaId, mime: copy.mime, size: copy.size } : mime ? { mime } : {}), ...(a.title ? { name: String(a.title).slice(0, 255) } : {}) })
      return
    }
    case 'cards':
    case 'card': {
      const children = block.type === 'cards' ? ((block.blocks ?? []) as string[]).map(id => ctx.byId.get(id)).filter((c): c is J => !!c && c.type === 'card' && !c.isCardHidden) : [block]
      if (!children.length) { seg.dropped.push('block:cards'); return }
      if (children.length > 10) seg.notes.push({ level: 'loss', code: 'cards_truncated', message: `Carrossel com ${children.length} cards: só os 10 primeiros entraram.` })
      const cards = children.slice(0, 10).map(c => {
        const buttons: J[] = []
        for (const id of (c.buttons ?? []) as string[]) {
          const b = ctx.buttons.get(id)
          if (!b) continue
          if (b.type === 'url' || b.type === 'cta_url') buttons.push({ type: 'url', title: text(b.caption), url: text(b.url) })
          else if (b.type === 'content') {
            buttons.push({ type: 'postback', title: text(b.caption), id: b.id })
            if (b.targetId) seg.notes.push({ level: 'loss', code: 'card_button_target', message: `Botão “${b.caption}” de card: o destino não foi importado (card ainda não liga botão a passo).` })
          }
        }
        if (buttons.length > 3) seg.notes.push({ level: 'loss', code: 'card_buttons_truncated', message: 'Card com mais de 3 botões: os extras não entraram.' })
        const image = c.image?.img_big ?? c.image?.img_original
        const action = typeof c.defaultAction?.url === 'string' ? c.defaultAction.url : undefined
        const copy = typeof image === 'string' && image ? copyOf(seg, image, ctx) : undefined
        return { title: text(c.title), ...(c.subtitle ? { subtitle: text(c.subtitle) } : {}), ...(typeof image === 'string' && image ? { imageUrl: copy?.url ?? image } : {}),
          ...(action ? { actionUrl: text(action) } : {}), ...(buttons.length ? { buttons: buttons.slice(0, 3) } : {}) }
      })
      seg.blocks.push({ kind: cards.length === 1 ? 'card' : 'gallery', aspectRatio: block.imageAspectRatio === 'square' ? 'square' : 'horizontal', cards })
      return
    }
    case 'template': {
      const body = ctx.templates.get(block.id)?.body
      if (!body) { seg.dropped.push('block:template'); return }
      seg.blocks.push({ kind: 'text', text: text(body) })
      addButtons(block.buttons)
      seg.notes.push({ level: 'attention', code: 'template_as_text', message: 'Modelo de mensagem virou texto simples: fora da janela de envio ele precisa de um modelo aprovado.' })
      return
    }
    default:
      // Teclado de canal vazio é só o contêiner padrão do passo; com botões, não há equivalente.
      if (/_keyboard$/.test(String(block.type)) && !(Array.isArray(block.buttonsStructure) && block.buttonsStructure.length)) return
      if (topLevel) seg.dropped.push(`block:${block.type}`)
  }
}
