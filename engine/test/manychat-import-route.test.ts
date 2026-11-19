import { beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import { authenticatedRequest as request, seedAuth } from './auth-helpers'
import { graphSchema } from '../src/schemas/graph'
import type { Env } from '../src/env'
import condGoto from './fixtures/manychat/cond_goto_template.json'
import actionsDelay from './fixtures/manychat/actions_delay.json'

type Imported = { automation: { id: string; name: string; status: string; draft_graph: { nodes: { id: string; type: string; config: Record<string, unknown> }[]; edges: unknown[] } }; created: boolean
  report: { source: { ns: string }; summary: { loss: number; attention: number }; items: { code: string }[] }; references: { kind: string; manychat_id: string; id: string; name: string; created: boolean; missing_in_origin: boolean }[]; resolved_incoming_links: number }
const post = (body: unknown, workspace = 'a') => request('imports/manychat', workspace, { method: 'POST', body: JSON.stringify(body) })
const tagId = (f: { clipboard: unknown }): string => {
  const nodes = (f.clipboard as { data: { nodesData: { related: { blocks: { filter?: { groups: { items: { type: string; value: number }[] }[] } }[] } }[] } }).data.nodesData
  return String(nodes.flatMap(x => x.related.blocks).flatMap(b => b.filter?.groups.flatMap(g => g.items) ?? []).find(item => item.type === 'tag')?.value)
}
beforeEach(async () => { await seedAuth() })

it('importa o fluxo como rascunho, cria etiquetas e campos pelo nome do mapa e lista o que foi criado', async () => {
  const tag = tagId(condGoto)
  const response = await post({ ...condGoto, names: { tags: { [tag]: { nome: 'Etiqueta de origem' } } } })
  expect(response.status).toBe(201)
  const body = await response.json() as Imported
  expect(body.created).toBe(true)
  expect(body.automation).toMatchObject({ status: 'draft', name: 'Texto 11' })
  expect(graphSchema.safeParse(body.automation.draft_graph).success).toBe(true)
  const named = body.references.find(r => r.kind === 'tag' && r.manychat_id === tag)!
  expect(named).toMatchObject({ name: 'Etiqueta de origem', created: true, missing_in_origin: false })
  expect(await env.DB.prepare('SELECT name FROM tags WHERE id=? AND workspace_id=?').bind(named.id, 'a').first()).toEqual({ name: 'Etiqueta de origem' })
  // a etiqueta é do workspace que importou
  expect(await env.DB.prepare("SELECT count(*) n FROM tags WHERE workspace_id='b' AND name='Etiqueta de origem'").first()).toEqual({ n: 0 })
  const row = await env.DB.prepare('SELECT source_ns FROM manychat_flow_origins WHERE automation_id=?').bind(body.automation.id).first()
  expect(row).toEqual({ source_ns: 'content_fixture_cond_goto_template' })
})

it('reimportar atualiza o rascunho no mesmo fluxo, sem duplicar fluxo, etiqueta nem campo', async () => {
  const first = await (await post(condGoto)).json() as Imported
  await env.DB.prepare('UPDATE automations SET name=? WHERE id=?').bind('Nome ajustado pela pessoa', first.automation.id).run()
  const before = await env.DB.batch([env.DB.prepare('SELECT count(*) n FROM automations'), env.DB.prepare('SELECT count(*) n FROM tags'), env.DB.prepare('SELECT count(*) n FROM custom_fields')])
  const second = await post(condGoto)
  expect(second.status).toBe(200)
  const body = await second.json() as Imported
  expect(body.created).toBe(false)
  expect(body.automation.id).toBe(first.automation.id)
  expect(body.automation.name).toBe('Nome ajustado pela pessoa')
  expect(body.references.every(r => !r.created)).toBe(true)
  const after = await env.DB.batch([env.DB.prepare('SELECT count(*) n FROM automations'), env.DB.prepare('SELECT count(*) n FROM tags'), env.DB.prepare('SELECT count(*) n FROM custom_fields')])
  expect(after.map(r => r.results)).toEqual(before.map(r => r.results))
})

it('casa por nome com etiqueta que já existe, usa o tipo do mapa ao criar campo e marca a referência sem nome como apagada na origem', async () => {
  const tag = tagId(condGoto)
  await env.DB.prepare("INSERT INTO tags(id,workspace_id,name) VALUES ('tag-existente','a','Já existia')").run()
  const withNames = { ...actionsDelay, names: { tags: { [tag]: { nome: 'x' } }, campos: {} as Record<string, { nome: string; tipo: string }> } }
  const ids = actionsDelay.clipboard.data.nodesData.flatMap(x => (x.node as { items?: { field_id?: number }[] }).items ?? []).flatMap(a => a.field_id ? [String(a.field_id)] : [])
  const known = ids[0]!
  withNames.names.campos[known] = { nome: 'Campo conhecido', tipo: 'number' }
  const body = await (await post(withNames)).json() as Imported
  const field = body.references.find(r => r.kind === 'field' && r.manychat_id === known)!
  expect(field).toMatchObject({ name: 'Campo conhecido', missing_in_origin: false })
  expect(await env.DB.prepare('SELECT type FROM custom_fields WHERE id=?').bind(field.id).first()).toEqual({ type: 'number' })
  const missing = body.references.filter(r => r.missing_in_origin)
  expect(missing.every(r => r.name.startsWith('Importado '))).toBe(true)
  // segunda tentativa usa a etiqueta já existente pelo nome
  await post({ ...condGoto, names: { tags: { [tag]: { nome: 'Já existia' } } } })
  expect(await env.DB.prepare("SELECT count(*) n FROM tags WHERE name='Já existia'").first()).toEqual({ n: 1 })
})

it('o goto pendente é ligado quando o fluxo de destino é importado depois', async () => {
  const goto = condGoto.clipboard.data.nodesData.find(x => x.node.nodeType === 'goto')!.node as { flowId: string }
  const first = await (await post(condGoto)).json() as Imported
  expect(first.automation.draft_graph.nodes.find(n => n.type === 'start_automation')!.config.automation_id).toBe('')
  const target = JSON.parse(JSON.stringify(actionsDelay)) as typeof actionsDelay
  for (const x of target.clipboard.data.nodesData) (x.node as { flow: string }).flow = goto.flowId
  target.original.flow.ns = goto.flowId
  const second = await (await post(target)).json() as Imported
  expect(second.resolved_incoming_links).toBe(1)
  const stored = await env.DB.prepare('SELECT draft_graph FROM automations WHERE id=?').bind(first.automation.id).first<{ draft_graph: string }>()
  const node = (JSON.parse(stored!.draft_graph) as Imported['automation']['draft_graph']).nodes.find(n => n.type === 'start_automation')!
  expect(node.config.automation_id).toBe(second.automation.id)
})

it('recusa clipboard inválido, papel sem edição e pasta de outro workspace', async () => {
  expect((await post({ clipboard: { $flowChart: 'outro' } })).status).toBe(400)
  expect((await post({ ...condGoto, folder_id: 'pasta-que-nao-existe' })).status).toBe(404)
  expect((await post({ clipboard: condGoto.clipboard, extra: 1 })).status).toBe(400)
  await env.DB.prepare(`UPDATE workspace_members SET role='viewer' WHERE workspace_id='a'`).run()
  expect((await post(condGoto)).status).toBe(403)
  expect(await env.DB.prepare('SELECT count(*) n FROM manychat_flow_origins').first()).toEqual({ n: 0 })
})

// ---- mídia da ManyChat copiada para o nosso armazenamento ----
const IMG = 'https://manybot-thumbnails.s3.eu-central-1.amazonaws.com/a/pic.png', VIDEO = 'https://manybot-files.s3.eu-central-1.amazonaws.com/a/clip.mp4'
const OTHER = 'https://res.cloudinary.com/x/pic.jpg'
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50])
const attachment = (id: string, type: string, url: string) => ({ id, type: 'attachment', attachmentType: type, blocks: [], buttons: [], attachment: { image_url: url } })
const mediaFlow = (ns: string, urls: [string, string][]) => ({ clipboard: { $flowChart: 'nodes', data: { offsets: {}, nodesData: [{ node: { id: 'm', nodeType: 'instagram', flow: ns, blocks: urls.map((_, i) => `b${i}`), targetId: null },
  related: { buttons: [], blocks: urls.map(([type, url], i) => attachment(`b${i}`, type, url)) } }] } } })
const withMedia = (extra: Partial<Env> = {}) => ({ ...env, APP_ENV: 'development', PUBLIC_BASE_URL: 'http://localhost:5822', ...extra } as Env)
const postMedia = (body: unknown, bindings = withMedia()) => request('imports/manychat', 'a', { method: 'POST', body: JSON.stringify(body) }, undefined, bindings)
const serve = (files: Record<string, Response | (() => Response)>) => vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
  const hit = files[String(input instanceof Request ? input.url : input)]
  if (!hit) throw new Error(`Rede proibida: ${String(input)}`)
  return typeof hit === 'function' ? hit() : hit.clone()
})
type MediaImported = Imported & { media: { source_url: string; status: string; media_id?: string; reason?: string }[] }

it('baixa a mídia da ManyChat, guarda no nosso armazenamento e o fluxo deixa de apontar para a ManyChat', async () => {
  const network = serve({ [IMG]: new Response(PNG, { headers: { 'content-type': 'image/png' } }), [VIDEO]: new Response(MP4, { headers: { 'content-type': 'video/mp4' } }) })
  const response = await postMedia(mediaFlow('ns-media-ok', [['image', IMG], ['video', VIDEO], ['image', OTHER]]))
  expect(response.status).toBe(201)
  const body = await response.json() as MediaImported
  expect(network.mock.calls.map(c => String(c[0])).sort()).toEqual([IMG, VIDEO].sort())
  expect(network.mock.calls.every(c => (c[1] as RequestInit).redirect === 'manual')).toBe(true)
  const stored = JSON.stringify(body.automation.draft_graph)
  expect(stored).not.toMatch(/manybot|manychat\.com|manybot\.io/)
  expect(stored).toContain(OTHER)
  expect(body.media.map(m => m.status)).toEqual(['copied', 'copied'])
  expect(body.report.summary).toMatchObject({ attention: 0 })
  const blocks = body.automation.draft_graph.nodes.find(n => n.type === 'message')!.config.blocks as { mediaId?: string; url: string; mime?: string; size?: number }[]
  expect(blocks[0]).toMatchObject({ mime: 'image/png', size: PNG.length, url: `http://localhost:5822/api/media/public/${blocks[0]!.mediaId}` })
  expect(await env.DB.prepare('SELECT workspace_id,content_type,size FROM media_objects WHERE id=?').bind(blocks[0]!.mediaId).first()).toEqual({ workspace_id: 'a', content_type: 'image/png', size: PNG.length })
  expect(await (await env.MEDIA!.get(blocks[0]!.mediaId!))!.arrayBuffer()).toEqual(PNG.buffer)
  network.mockRestore()
})

it('reimportar reaproveita a mídia já guardada, sem baixar de novo nem duplicar objeto', async () => {
  const flow = mediaFlow('ns-media-twice', [['image', IMG]])
  const first = serve({ [IMG]: new Response(PNG, { headers: { 'content-type': 'image/png' } }) })
  await postMedia(flow)
  first.mockRestore()
  const before = await env.DB.prepare('SELECT count(*) n FROM media_objects').first()
  const second = serve({})
  const body = await (await postMedia(flow)).json() as MediaImported
  expect(second).not.toHaveBeenCalled()
  expect(body.media[0]).toMatchObject({ status: 'reused' })
  expect(await env.DB.prepare('SELECT count(*) n FROM media_objects').first()).toEqual(before)
  second.mockRestore()
})

it.each([
  ['resposta 404', () => new Response('nada', { status: 404 }), 'HTTP 404'],
  ['redirecionamento', () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/x' } }), 'HTTP 302'],
  ['tipo não aceito', () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }), 'tipo'],
  ['conteúdo que não bate com o tipo', () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'image/png' } }), 'conteúdo'],
  ['arquivo acima do limite', () => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(40 * 1024 * 1024) } }), 'limite'],
] as const)('falha de download (%s) vira pendência no relatório e a importação continua', async (_name, make, reason) => {
  const network = serve({ [IMG]: make })
  const response = await postMedia(mediaFlow('ns-media-fail', [['image', IMG]]))
  expect(response.status).toBe(201)
  const body = await response.json() as MediaImported
  expect(body.media[0]).toMatchObject({ source_url: IMG, status: 'failed' })
  expect(body.media[0]!.reason).toContain(reason)
  expect(body.report.summary.attention).toBeGreaterThan(0)
  expect(body.report.items.find(i => i.code === 'media_download_failed')).toBeTruthy()
  expect(JSON.stringify(body.automation.draft_graph)).toContain(IMG)
  expect(await env.DB.prepare('SELECT count(*) n FROM media_objects').first()).toEqual({ n: 0 })
  network.mockRestore()
})

it('arquivo sem content-length que passa do limite durante a leitura também é recusado', async () => {
  const big = new Uint8Array(26 * 1024 * 1024); big.set(PNG)
  const network = serve({ [IMG]: new Response(big, { headers: { 'content-type': 'image/png' } }) })
  const body = await (await postMedia(mediaFlow('ns-media-big', [['image', IMG]]))).json() as MediaImported
  expect(body.media[0]).toMatchObject({ status: 'failed' })
  network.mockRestore()
})

it('sem armazenamento configurado a mídia fica pendente e a importação segue', async () => {
  const network = serve({})
  const body = await (await postMedia(mediaFlow('ns-media-nostorage', [['image', IMG]]), withMedia({ MEDIA: undefined }))).json() as MediaImported
  expect(body.media[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('armazenamento') })
  expect(network).not.toHaveBeenCalled()
  network.mockRestore()
})

it('o servidor da ManyChat não é acessado por endereço que não seja dela: só hosts conhecidos são baixados', async () => {
  const network = serve({})
  const evil = 'https://manybot-files.s3.eu-central-1.amazonaws.com.evil.test/x.png'
  const body = await (await postMedia(mediaFlow('ns-media-host', [['image', evil], ['image', 'http://manybot-files.s3.eu-central-1.amazonaws.com/x.png']]))).json() as MediaImported
  expect(network).not.toHaveBeenCalled()
  expect(body.media).toEqual([])
  network.mockRestore()
})
