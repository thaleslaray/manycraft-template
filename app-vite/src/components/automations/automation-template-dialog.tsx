import * as React from 'react'
import { FieldSelect } from "@/components/ui/field-select"
import { useNavigate } from 'react-router'
import { channelGlyphs } from '@/components/editor/channel-badge'
import { channelLabels } from '@/components/editor/graph'
import { ArrowLeft, ArrowRight, Download, LayoutGrid, Link2, MessageCircle, Plus, Search, Zap } from 'lucide-react'
import { listConnections } from '@/data/connections'
import { createFromTemplate, listAutomationTemplates, type AutomationTemplate } from '@/data/automation-templates'
import { useAsync } from '@/hooks/use-async'
import { Banner } from '@/components/ui/banner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { filterTemplates, listCategories } from './automation-template-logic'
const nomeCanal = channelLabels as Record<string, string | undefined>

const triggerKinds: { kind: AutomationTemplate['trigger']['kind']; label: string }[] = [{ kind: 'keyword', label: 'Palavra-chave' }, { kind: 'welcome_message', label: 'Boas-vindas' }]
/** Modelo que a maioria começa usando: leva o selo Popular. */
const popularTemplate = 'boas-vindas'

export function AutomationTemplateDialog({ workspace, folderId, blankBusy, onBlank, onQuick, onImport, onClose }: {
  workspace: string; folderId: string | null; blankBusy: boolean; onBlank: () => Promise<void>; onQuick?: () => void; onImport?: () => void; onClose: () => void
}) {
  const navigate = useNavigate()
  const [search, setSearch] = React.useState('')
  const [category, setCategory] = React.useState('Todos')
  const [trigger, setTrigger] = React.useState<string>('')
  const [channel, setChannel] = React.useState('')
  const [selected, setSelected] = React.useState<string>()
  const [connectionId, setConnectionId] = React.useState('')
  const [word, setWord] = React.useState('')
  const [url, setUrl] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const connections = useAsync(() => listConnections(workspace), workspace)
  // Entrar de novo na prévia relê a ficha; avisos antigos nunca liberam a criação durante a carga.
  const query = useAsync(() => listAutomationTemplates(connectionId || undefined), `${connectionId}|${selected ?? ''}`)
  const templates = query.data?.templates ?? query.stale?.templates ?? []
  const model = templates.find(t => t.id === selected)
  const filtered = filterTemplates(templates, category, search, trigger)
  const channelKinds = [...new Set((connections.data ?? []).map(c => c.kind))].filter(kind => nomeCanal[kind])
  const channelConnections = (connections.data ?? []).filter(c => !channel || c.kind === channel)
  const categories = listCategories(templates)
  function preview(template: AutomationTemplate) {
    setSelected(template.id); setWord(template.trigger.word ?? ''); setUrl(template.link?.url ?? ''); setError(undefined)
    // Com um canal escolhido na aba e uma só conexão dele, a conexão já vem escolhida.
    if (channel && !connectionId && channelConnections.length === 1) setConnectionId(channelConnections[0].id)
  }
  async function create(event: React.FormEvent) {
    event.preventDefault()
    if (!model || !connectionId || query.loading || model.warnings.length || busy) return
    setBusy(true); setError(undefined)
    try {
      const automation = await createFromTemplate({ template_id: model.id, version: model.version, connection_id: connectionId, folder_id: folderId,
        ...(model.trigger.word ? { word } : {}), ...(model.link ? { url } : {}) })
      navigate(`/${workspace}/automations/${automation.id}`)
    } catch (error) { setError(error instanceof Error ? error.message : 'Não foi possível criar a automação. Tente novamente.') }
    finally { setBusy(false) }
  }
  const locked = busy || blankBusy
  return <Dialog open onOpenChange={open => { if (!open && !locked) onClose() }}>
    <DialogContent className="top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 md:top-[1.9rem] md:left-1/2 md:h-[calc(100dvh-7.1rem)] md:w-[calc(100%-2rem)] md:max-w-[75rem] md:-translate-x-1/2 md:translate-y-0 md:rounded-lg">
      <DialogHeader className="flex shrink-0 flex-row flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3 pr-14 sm:pr-16 sm:pl-6">
        <DialogTitle className="text-base font-bold">Modelos</DialogTitle>
        <DialogDescription className="sr-only">Escolha um ponto de partida e adapte as mensagens ao seu negócio.</DialogDescription>
        <div className="flex flex-wrap items-center gap-2">{onImport ? <Button variant="secondary" size="sm" disabled={busy || blankBusy} onClick={onImport}><Download className="size-4" />Importar da ManyChat</Button> : null}{onQuick ? <Button variant="secondary" size="sm" disabled={busy || blankBusy} onClick={onQuick}><Zap className="size-4" />Automação rápida</Button> : null}<Button variant="secondary" size="sm" loading={blankBusy} disabled={busy} onClick={() => void onBlank()}><Plus className="size-4" />Começar do zero</Button></div>
      </DialogHeader>
      {selected ? <form onSubmit={create} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-border px-5 py-3 sm:px-8"><Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => { setSelected(undefined); setError(undefined) }}><ArrowLeft className="size-4" />Voltar aos modelos</Button></div>
        <div className="grid min-w-0 md:grid-cols-2">
          <div className="min-w-0 space-y-5 p-5 sm:p-8">
            {model ? <>
              <div><p className="mb-2 text-xs font-semibold text-text-muted">{model.category}</p><h2 className="text-xl font-semibold">{model.name}</h2><p className="mt-2 text-sm text-text-muted">{model.description}</p></div>
              <FieldSelect id="template-connection" label="Conexão do modelo" required disabled={locked || connections.loading} value={connectionId} placeholder="Escolha uma conexão" options={channelConnections.map(c => ({ value: c.id, label: c.displayName ?? c.label }))} onChange={id => { setConnectionId(id); setError(undefined) }} />
              {!connections.loading && !connections.error && !connections.data?.length ? <Banner>Conecte uma conta em Configurações para usar um modelo. Você também pode começar do zero.</Banner> : null}
              {model.trigger.word ? <label className="block space-y-2 text-sm font-semibold">Palavra que inicia<Input aria-label="Palavra que inicia" required maxLength={100} value={word} disabled={locked} onChange={e => setWord(e.target.value)} /></label> : <p className="flex items-center gap-2 text-sm"><Zap className="size-4 shrink-0" />{model.trigger.label}</p>}
              {model.link ? <label className="block space-y-2 text-sm font-semibold">Link de destino<Input type="url" pattern="https?://.+" aria-label="Link de destino" required maxLength={2000} value={url} disabled={locked} onChange={e => setUrl(e.target.value)} /><span className="block text-xs font-normal text-text-muted">Troque o endereço de exemplo pelo link do seu negócio.</span></label> : null}
              <p className="text-xs text-text-muted">O modelo será salvo como rascunho. Revise os textos e dados de exemplo no editor antes de publicar.</p>
              {connectionId && query.loading ? <p role="status" className="text-sm text-text-muted">Verificando recursos da conexão…</p> : null}
              {!query.loading && connectionId ? model.warnings.map(w => <Banner key={w} variant="warning">{w}</Banner>) : null}
            </> : <p role="status">Carregando prévia…</p>}
            {connections.error ? <Banner variant="danger">{connections.error.message} <Button type="button" variant="secondary" size="sm" onClick={connections.reload}>Recarregar conexões</Button></Banner> : null}
            {query.error ? <Banner variant="danger">{query.error.message} <Button type="button" variant="secondary" size="sm" onClick={query.reload}>Recarregar modelos</Button></Banner> : null}
            {error ? <Banner variant="danger">{error}</Banner> : null}
          </div>
          <div className="min-w-0 border-t border-border bg-bg p-5 sm:p-8 md:border-t-0 md:border-l">
            <p className="mb-5 flex items-center gap-2 text-sm font-semibold"><MessageCircle className="size-4" />Prévia das mensagens</p>
            <div className="mx-auto max-w-sm space-y-4 rounded-lg border border-border bg-surface p-5 shadow-card" aria-label="Prévia do modelo">
              <p className="border-b border-border pb-3 text-xs text-text-muted">{model?.trigger.word ? `Ao receber “${word || model.trigger.word}”` : model?.trigger.label}</p>
              {model?.graph.nodes.filter(n => n.type === 'message').map(node => <div key={node.id} className="space-y-2">{(node.config.blocks as { kind: string; text?: string; label?: string }[]).map((block, i) => block.kind === 'text'
                ? <p key={i} className="rounded-lg rounded-tl-sm bg-bg p-4 text-sm leading-relaxed">{block.text}</p>
                : <div key={i} className="flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-semibold"><Link2 className="size-4" />{block.label}</div>)}</div>)}
              <p className="text-xs text-text-muted">Esta prévia não envia mensagens.</p>
            </div>
          </div>
        </div>
        </div>
        <div className="flex shrink-0 justify-end border-t border-border p-4 sm:px-8"><Button type="submit" className="bg-text text-surface" loading={busy} disabled={!model || !connectionId || query.loading || Boolean(query.error) || connections.loading || Boolean(connections.error) || Boolean(model?.warnings.length) || blankBusy || Boolean(model?.trigger.word && !word.trim()) || Boolean(model?.link && !url.trim())}>Usar este modelo<ArrowRight className="size-4" /></Button></div>
      </form> : <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 pt-2 sm:px-6">
          <div role="tablist" aria-label="Canal" className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
            {[{ kind: '', label: 'Todos os canais', Icon: LayoutGrid }, ...channelKinds.map(kind => ({ kind, label: nomeCanal[kind], Icon: channelGlyphs[kind] ?? MessageCircle }))].map(tab => <button key={tab.kind || 'todos'} type="button" role="tab" aria-selected={channel === tab.kind} onClick={() => { setChannel(tab.kind); setConnectionId('') }} className={cn('flex shrink-0 items-center gap-2 border-b-2 px-3 pt-2 pb-2.5 text-sm font-medium whitespace-nowrap transition-colors', channel === tab.kind ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text')}><tab.Icon className="size-4" aria-hidden="true" />{tab.label}</button>)}
          </div>
          <div className="relative w-full pb-2 sm:w-72"><Search className="absolute top-3 left-3 size-4 text-text-muted" aria-hidden="true" /><Input aria-label="Buscar modelos" placeholder={channel ? `Buscar modelos de ${nomeCanal[channel]}` : 'Buscar modelos'} className="pl-9" value={search} onChange={e => setSearch(e.target.value)} /></div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="flex shrink-0 flex-col md:w-56 md:overflow-y-auto md:px-4 md:pt-8 md:pb-3">
        <nav aria-label="Categorias de modelos" className="flex flex-row items-center gap-1 overflow-x-auto border-b border-border p-3 [scrollbar-width:none] md:flex-col md:items-stretch md:overflow-x-visible md:border-b-0 md:p-0 [&::-webkit-scrollbar]:hidden">
          {categories.map((c, i) => <React.Fragment key={c.name}>
            {i === 1 ? <p className="hidden px-3 pt-5 pb-1 text-sm font-semibold md:block">Por objetivo</p> : null}
            <Button variant="ghost" size="sm" aria-pressed={c.name === category && !trigger} className={cn('shrink-0 justify-start whitespace-nowrap font-medium md:w-full', c.name === category && !trigger && 'bg-border/40 text-text')} onClick={() => { setCategory(c.name); setTrigger('') }}>{c.name === 'Todos' ? 'Todos os modelos' : c.name}</Button>
          </React.Fragment>)}
        </nav>
        <nav aria-label="Gatilhos de modelos" className="flex flex-row items-center gap-1 overflow-x-auto border-b border-border p-3 [scrollbar-width:none] md:flex-col md:items-stretch md:overflow-x-visible md:border-b-0 md:p-0 [&::-webkit-scrollbar]:hidden">
          <p className="hidden px-3 pt-5 pb-1 text-sm font-semibold md:block">Por gatilho</p>
          {triggerKinds.filter(item => templates.some(t => t.trigger.kind === item.kind)).map(item => <Button key={item.kind} variant="ghost" size="sm" aria-pressed={trigger === item.kind} className={cn('shrink-0 justify-start whitespace-nowrap font-medium md:w-full', trigger === item.kind && 'bg-border/40 text-text')} onClick={() => { setTrigger(trigger === item.kind ? '' : item.kind); setCategory('Todos') }}>{item.label}</Button>)}
        </nav>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5 sm:px-6 md:pt-8">
          {query.loading ? <p role="status" className="text-sm text-text-muted">Carregando modelos…</p> : query.error ? <Banner variant="danger">{query.error.message} <Button variant="secondary" size="sm" onClick={query.reload}>Tentar novamente</Button></Banner> : <>
            <ul aria-label="Modelos" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{filtered.map((template, i) => {
              const sections = category === 'Todos' && !trigger && !search.trim() && filtered.length > 3
              return <React.Fragment key={template.id}>
                {sections && (i === 0 || i === 3) ? <li className={cn('col-span-full', i === 3 && 'mt-3')}><h2 className="text-base font-semibold">{i === 0 ? 'Recomendados' : 'Descubra mais modelos'}</h2></li> : null}
                <li className="contents"><button aria-label={`Ver modelo: ${template.name}`} onClick={() => preview(template)} className="flex min-h-36 flex-col sm:min-h-56 items-start rounded-md border border-border bg-surface p-4 text-left transition-colors hover:bg-surface-muted">
                  <h3 className="text-lg leading-snug font-semibold">{template.name}</h3><p className="mt-2 mb-4 text-sm text-text-muted">{template.description}</p>
                  <span className="mt-auto flex w-full items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-xs text-text-muted"><Zap className="size-3.5" aria-hidden="true" />{template.category}</span>{template.id === popularTemplate ? <span className="rounded-sm bg-warning px-1.5 py-0.5 text-2xs font-bold tracking-wide text-on-accent uppercase">Popular</span> : null}</span>
                </button></li>
              </React.Fragment>
            })}</ul>
            {!filtered.length ? <p className="py-8 text-center text-sm text-text-muted">Nenhum modelo encontrado</p> : null}
          </>}
        </div>
        </div>
      </div>}
    </DialogContent>
  </Dialog>
}
