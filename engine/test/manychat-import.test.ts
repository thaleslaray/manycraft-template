import { describe, expect, it } from 'vitest'
import { collectRefs, memoryResolver, translateClipboard } from '../src/flow/manychat-import'
import { actionSchema } from '../src/schemas/actions'
import { disconnectedSteps, validateGraph } from '../src/schemas/graph'
import { flowConditionSchema, smartDelaySchema } from '../src/schemas/temporal'
import quickQuestion from './fixtures/manychat/quick_question.json'
import condGoto from './fixtures/manychat/cond_goto_template.json'
import actionsDelay from './fixtures/manychat/actions_delay.json'
import splitCards from './fixtures/manychat/split_cards.json'
import unsupportedMix from './fixtures/manychat/unsupported_mix.json'

type Fixture = { clipboard: unknown; original?: unknown }
const run = (f: Fixture, imported: Record<string, string> = {}) => {
  const refs = memoryResolver(collectRefs(f.clipboard), imported)
  const result = translateClipboard(f.clipboard, { refs, original: f.original })
  validateGraph(result.graph)
  return result
}
const byType = (r: ReturnType<typeof run>, type: string) => r.graph.nodes.filter(n => n.type === type)

describe('tradutor de fluxos da ManyChat', () => {
  it('todas as fixtures viram grafos que passam em validateGraph e têm uma entrada ligada ao gatilho', () => {
    for (const f of [quickQuestion, condGoto, actionsDelay, splitCards, unsupportedMix] as Fixture[]) {
      const r = run(f)
      expect(r.graph.nodes[0]).toMatchObject({ id: 'trigger', type: 'trigger' })
      expect(r.graph.edges[0]).toMatchObject({ from: 'trigger', port: 'next' })
      expect(r.graph.edges.every(e => r.graph.nodes.some(n => n.id === e.to))).toBe(true)
      expect(r.graph.origin.source).toBe('manychat')
    }
  })

  it('mensagem com atraso e botão e pergunta em outro passo: atraso vira digitação, pergunta mantém id e saída de tempo esgotado', () => {
    const r = run(quickQuestion as Fixture)
    const message = byType(r, 'message')[0]!, question = byType(r, 'question')[0]!
    const kinds = (message.config.blocks as { kind: string }[]).map(b => b.kind)
    expect(kinds).toEqual(expect.arrayContaining(['text', 'typing']))
    expect(question.id).toBe('n02')
    expect(question.config).toMatchObject({ answer_type: expect.any(String), max_attempts: expect.any(Number), timeout: { unit: expect.any(String) } })
    expect(message.config.channel).toBe('instagram')
  })

  it('pergunta no meio de uma mensagem divide em mensagem, pergunta e mensagem, ligadas em ordem', () => {
    const clip = { $flowChart: 'nodes', data: { offsets: {}, nodesData: [
      { node: { id: 'm', nodeType: 'instagram', flow: 'ns3', blocks: ['t1', 'q', 't2'], targetId: 'z' }, related: { buttons: [], blocks: [
        { id: 't1', type: 'text', text: 'antes', blocks: [], buttons: [] },
        { id: 'q', type: 'question', text: 'Qual?', replyType: 'email', customFieldId: 9, answerRetries: 2, questionAnswerTimeout: { unit: 'minutes', value: '5' }, blocks: ['qt'], buttons: [], targetId: null },
        { id: 'qt', type: 'question_timeout', targetId: 'z2', blocks: [], buttons: [] },
        { id: 't2', type: 'text', text: 'depois', blocks: [], buttons: [] }] } },
      ...['z', 'z2'].map(id => ({ node: { id, nodeType: 'actionGroup', flow: 'ns3', items: [], blocks: [] }, related: { blocks: [], buttons: [] } })),
    ] } }
    const r = translateClipboard(clip, { refs: memoryResolver(collectRefs(clip)) })
    validateGraph(r.graph)
    expect(r.graph.edges).toEqual(expect.arrayContaining([{ from: 'm', port: 'next', to: 'm~1' }, { from: 'm~1', port: 'success', to: 'm~2' },
      { from: 'm~1', port: 'no_response', to: 'z2' }, { from: 'm~2', port: 'next', to: 'z' }]))
    expect(r.graph.nodes.find(n => n.id === 'm~1')!.config).toMatchObject({ answer_type: 'email', field_id: 'field:9', max_attempts: 3, timeout: { value: 5, unit: 'minutes' } })
  })

  it.each([
    ['first_name', {}, 'system:first_name'], ['last_name', {}, 'system:last_name'],
    ['email', { saveEmailToSystemField: true }, 'system:email'], ['phone', { savePhoneToSystemField: true }, 'system:phone'],
    ['phone', { savePhoneToWhatsAppIdSystemField: true }, 'system:phone'], ['email', {}, ''], ['free_text', {}, ''], ['email', { customFieldId: 9, saveEmailToSystemField: true }, 'field:9'],
  ])('pergunta %s %j grava em "%s"', (replyType, extra, expected) => {
    const clip = { $flowChart: 'nodes', data: { offsets: {}, nodesData: [
      { node: { id: 'm', nodeType: 'instagram', flow: 'ns3', blocks: ['q'], targetId: null }, related: { buttons: [], blocks: [
        { id: 'q', type: 'question', text: 'Qual?', replyType, customFieldId: null, blocks: [], buttons: [], targetId: null, ...extra }] } },
    ] } }
    const r = run({ clipboard: clip })
    expect(byType(r, 'question')[0]!.config.field_id).toBe(expected)
    expect(r.report.items.some(i => i.code === 'question_no_field')).toBe(!expected)
    expect(r.report.items.some(i => i.code === 'question_system_field')).toBe(false)
  })

  it('condição vira condition válida; goto aponta para o fluxo já importado; modelo de WhatsApp usa o texto do original', () => {
    const ns = (condGoto.clipboard.data.nodesData.find(x => x.node.nodeType === 'goto')!.node as { flowId: string }).flowId
    const r = run(condGoto as Fixture, { [ns]: 'auto-destino' })
    for (const c of byType(r, 'condition')) expect(flowConditionSchema.safeParse(c.config).success).toBe(true)
    expect(byType(r, 'start_automation')[0]!.config).toMatchObject({ automation_id: 'auto-destino', source_flow_ns: ns })
    const texts = byType(r, 'message').flatMap(m => (m.config.blocks as { kind: string; text?: string }[]).filter(b => b.kind === 'text').map(b => b.text))
    expect(texts.some(t => t?.startsWith('Texto'))).toBe(true)
    expect(run(condGoto as Fixture).report.items.some(i => i.code === 'goto_unresolved')).toBe(true)
    expect(r.graph.edges.find(e => e.from === 'trigger')!.to).toBe(r.entry)
  })

  it('ações e atraso inteligente: etiquetas e campos viram ações nossas; o que não tem equivalente vira nota "Não importado"', () => {
    const r = run(actionsDelay as Fixture)
    const actions = byType(r, 'action').flatMap(n => n.config.actions as { type: string }[])
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.every(a => typeof a.type === 'string')).toBe(true)
    for (const d of byType(r, 'smart_delay')) expect(smartDelaySchema.safeParse(d.config).success).toBe(true)
    const notes = byType(r, 'note').filter(n => n.config.imported_unsupported)
    expect(notes.every(n => String(n.config.text).startsWith('Não importado: '))).toBe(true)
    expect(Object.keys(r.report.unsupported).some(k => k.startsWith('integration_request'))).toBe(notes.length > 0)
  })

  it('divisão vira randomizer com pesos e uma saída por caminho; cards e mídia mantêm a URL original e entram no relatório', () => {
    const r = run(splitCards as Fixture)
    const split = byType(r, 'randomizer')[0]!
    const variations = split.config.variations as { id: string; weight: number }[]
    expect(variations.length).toBeGreaterThanOrEqual(2)
    for (const v of variations) expect(r.graph.edges.some(e => e.from === split.id && e.port === v.id)).toBe(true)
    expect(r.report.media.every(m => m.url.startsWith('https://exemplo.test/'))).toBe(true)
  })

  it('tipo fora do escopo não derruba a importação: vira nota que segue adiante e entra no relatório', () => {
    const r = run(unsupportedMix as Fixture)
    expect(r.report.unsupported['node:email_new']).toBeGreaterThan(0)
    const note = byType(r, 'note').find(n => n.config.imported_unsupported === 'node:email_new')!
    expect(note.config.text).toBe('Não importado: node:email_new')
    expect(r.report.items.some(i => i.level === 'loss' && i.code === 'node_unsupported')).toBe(true)
  })

  it('traduz {{cuf_N}} para a variável de campo nossa e avisa as variáveis sem equivalente', () => {
    const clip = { $flowChart: 'nodes', pageId: 'p', data: { offsets: {}, nodesData: [{ node: { id: 'm', nodeType: 'instagram', flow: 'ns1', blocks: ['t'], targetId: null },
      related: { buttons: [], blocks: [{ id: 't', type: 'text', text: 'Oi {{first_name|fallback:"amigo"}} {{cuf_77}} {{page_id}}', blocks: [], buttons: [] }] } }] } }
    const r = translateClipboard(clip, { refs: memoryResolver(collectRefs(clip)) })
    const text = (byType({ graph: r.graph } as never, 'message')[0]!.config.blocks as { text: string }[])[0]!.text
    expect(text).toBe('Oi {{primeiro_nome|amigo}} {{campo:field%3A77|}} {{page_id}}')
    expect(r.report.items.some(i => i.code === 'variable' && i.message.includes('page_id'))).toBe(true)
  })

  it('ações de inscrição e cancelamento por canal entram sem pendência e passam na validação das ações', () => {
    const types = ['instagram', 'whatsapp', 'email', 'tiktok', 'telegram'].flatMap(c => [`set_${c}_optin`, `set_${c}_optout`])
    const clip = { $flowChart: 'nodes', data: { offsets: {}, nodesData: [
      { node: { id: 'g', nodeType: 'actionGroup', flow: 'ns2', items: types.map((type, i) => ({ _oid: `o${i}`, type })), blocks: [] },
        related: { buttons: [], blocks: [] } },
    ] } }
    const r = translateClipboard(clip, { refs: memoryResolver(collectRefs(clip)) })
    validateGraph(r.graph)
    const actions = byType({ graph: r.graph } as never, 'action').flatMap(n => n.config.actions as { type: string }[])
    expect(actions.map(a => a.type)).toEqual(types.map(t => t.replace('optin', 'opt_in').replace('optout', 'opt_out')))
    expect(actions.every(a => actionSchema.safeParse(a).success)).toBe(true)
    expect(r.report.items.filter(i => i.code === 'opt_action')).toEqual([])
    expect(r.report.unsupported).toEqual({})
  })

  it('cadeia de casos vira condições encadeadas e uma condição impossível de traduzir deixa nota solta', () => {
    const item = (field: string, operator: string, value?: unknown) => ({ field, operator, type: field === 'tag' ? 'tag' : 'cuf', value })
    const kase = (id: string, items: object[], target: string) => ({ id, type: 'case', blocks: [], buttons: [], targetId: target, filter: { operator: 'AND', groups: [{ operator: 'AND', items }] } })
    const clip = { $flowChart: 'nodes', data: { offsets: {}, nodesData: [
      { node: { id: 'c', nodeType: 'condition', flow: 'ns2', blocks: ['a', 'b', 'x', 'd'] }, related: { buttons: [], blocks: [
        kase('a', [item('tag', 'IS', 11)], 'A'), kase('b', [item('cuf_5', 'GREATER_THAN', '3')], 'B'), kase('x', [item('cuf_6', 'BEFORE', 'createDateTime({{cuf_1}})')], 'X'),
        { id: 'd', type: 'default', blocks: [], buttons: [], targetId: 'D' }] } },
      ...['A', 'B', 'D', 'X'].map(id => ({ node: { id, nodeType: 'actionGroup', flow: 'ns2', items: [], blocks: [] }, related: { blocks: [], buttons: [] } })),
    ] } }
    const r = translateClipboard(clip, { refs: memoryResolver(collectRefs(clip)) })
    validateGraph(r.graph)
    const conds = byType({ graph: r.graph } as never, 'condition')
    expect(conds).toHaveLength(2)
    expect(r.graph.edges).toEqual(expect.arrayContaining([{ from: 'c', port: 'true', to: 'A' }, { from: 'c', port: 'false', to: 'c~c2' }, { from: 'c~c2', port: 'true', to: 'B' }, { from: 'c~c2', port: 'false', to: 'D' }]))
    expect(r.graph.edges).toContainEqual({ from: 'c~x1', port: 'next', to: 'X' })
    expect(r.report.items.some(i => i.code === 'condition_unsupported')).toBe(true)
    expect(collectRefs(clip).fields.get('5')).toBe('number')
  })

  it('o resultado é determinístico e nenhum passo fica sem posição', () => {
    const a = run(splitCards as Fixture), b = run(splitCards as Fixture)
    expect(JSON.stringify(a.graph)).toBe(JSON.stringify(b.graph))
    expect(a.graph.nodes.every(n => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true)
    expect(disconnectedSteps(a.graph as never)).toEqual([])
  })

  it('botão de link com destino liga a saída do botão ao passo, sem perda', () => {
    const clip = { $flowChart: 'nodes', data: { offsets: {}, nodesData: [
      { node: { id: 'm', nodeType: 'instagram', flow: 'ns5', blocks: ['t1'], targetId: null }, related: { buttons: [
        { id: 'bu', type: 'url', caption: 'Site', url: 'https://exemplo.test/x', targetId: 'z' }], blocks: [
        { id: 't1', type: 'text', text: 'oi', blocks: [], buttons: ['bu'] }] } },
      { node: { id: 'z', nodeType: 'actionGroup', flow: 'ns5', items: [], blocks: [] }, related: { blocks: [], buttons: [] } },
    ] } }
    const r = translateClipboard(clip, { refs: memoryResolver(collectRefs(clip)) })
    validateGraph(r.graph)
    expect(r.graph.edges).toContainEqual({ from: 'm', port: 'btn:bu', to: 'z' })
    expect(r.report.items.some(i => i.code === 'url_button_target')).toBe(false)
  })

  describe('mídia da ManyChat', () => {
    const IMG = 'https://manybot-thumbnails.s3.eu-central-1.amazonaws.com/a/pic.png', VIDEO = 'https://manybot-files.s3.eu-central-1.amazonaws.com/a/clip.mp4'
    const CARD = 'https://manybot-thumbnails.s3.eu-central-1.amazonaws.com/a/card.jpg', OTHER = 'https://res.cloudinary.com/x/pic.jpg'
    const attachment = (id: string, type: string, url: string, extra: object = {}) => ({ id, type: 'attachment', attachmentType: type, blocks: [], buttons: [], attachment: { image_url: url, ...extra } })
    const clip = { $flowChart: 'nodes', data: { offsets: {}, nodesData: [{ node: { id: 'm', nodeType: 'instagram', flow: 'ns-media', blocks: ['i', 'v', 'o', 'c'], targetId: null }, related: { buttons: [], blocks: [
      attachment('i', 'image', IMG), attachment('v', 'video', VIDEO, { mime: 'video/mp4' }), attachment('o', 'image', OTHER),
      { id: 'c', type: 'card', blocks: [], buttons: [], title: 'Card', image: { img_big: CARD } }] } }] } }
    const translate = (media?: (url: string) => unknown) => {
      const r = translateClipboard(clip, { refs: memoryResolver(collectRefs(clip)), media: media as never })
      validateGraph(r.graph)
      return r
    }
    const blocks = (r: ReturnType<typeof translate>) => r.graph.nodes.find(n => n.type === 'message')!.config.blocks as { kind: string; url?: string; mediaId?: string; imageUrl?: string; cards?: { imageUrl?: string }[]; mime?: string; size?: number }[]

    it('sem cópia, só endereço da ManyChat entra na lista a copiar e vira pendência', () => {
      const r = translate()
      expect(r.report.media.map(m => m.url)).toEqual([IMG, VIDEO, CARD])
      expect(r.report.items.filter(i => i.code === 'media_url')).toHaveLength(1)
    })

    it('com cópia feita, o fluxo aponta para o nosso armazenamento e a pendência some', () => {
      const r = translate(url => url === OTHER ? undefined : { mediaId: `id-${url.length}`, url: `https://media.test/id-${url.length}`, mime: url.endsWith('.mp4') ? 'video/mp4' : 'image/png', size: 10 })
      const b = blocks(r)
      expect(b[0]).toMatchObject({ kind: 'media', url: `https://media.test/id-${IMG.length}`, mediaId: `id-${IMG.length}`, mime: 'image/png', size: 10 })
      expect(b[1]).toMatchObject({ mediaId: `id-${VIDEO.length}`, mime: 'video/mp4' })
      expect(b[2]).toMatchObject({ url: OTHER })
      expect(JSON.stringify(r.graph)).not.toContain('manybot')
      expect(r.report.items.some(i => i.code === 'media_url' || i.code === 'media_download_failed')).toBe(false)
    })

    it('falha de cópia mantém o endereço original e entra no relatório com o motivo, sem derrubar', () => {
      const r = translate(url => url === VIDEO ? { error: 'Arquivo acima do limite.' } : { mediaId: 'ok', url: 'https://media.test/ok', mime: 'image/png', size: 1 })
      expect(blocks(r)[1]).toMatchObject({ url: VIDEO })
      expect(blocks(r)[1]!.mediaId).toBeUndefined()
      const failed = r.report.items.filter(i => i.code === 'media_download_failed')
      expect(failed).toHaveLength(1)
      expect(failed[0]!.message).toContain('Arquivo acima do limite.')
    })
  })
})
