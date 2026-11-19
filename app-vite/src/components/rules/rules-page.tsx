import * as React from 'react'
import { Link, useParams } from 'react-router'
import { ArrowDown, ArrowLeft, Eraser, GitBranch, ListMinus, ListPlus, PenLine, Play, Plus, Search, Tag, Tags, Trash2, Zap, type LucideIcon } from 'lucide-react'
import { listRules, ruleProblem, saveRule, publishRule, setRuleActive, duplicateRule, deleteRule, type Rule, type RuleInput, type RuleAction, type RuleConfig, type SystemField, systemFieldNames } from '@/data/rules'
import { getSettings } from '@/data/settings'
import { listSequences, listSequenceFlows } from '@/data/sequences'
import { useAsync } from '@/hooks/use-async'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Banner } from '@/components/ui/banner'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { PageFooterBar } from '@/components/ui/page-footer-bar'
import { Skeleton } from '@/components/ui/skeleton'
import { RowMenu, RowMenuItem } from '@/components/ui/row-menu'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { RuleConditions, RuleValue, SelectField, type RuleCatalog } from './rule-fields'

const rowGrid = 'md:grid-cols-[7.5rem_minmax(0,1fr)_6rem_8rem_2rem]'
export const triggerNames = { tag_added: 'Tag aplicada', tag_removed: 'Tag removida', field_changed: 'Campo alterado', contact_created: 'Contato criado', sequence_entered: 'Entrada em sequência', date: 'Data do contato', system_field_changed: 'Dado do contato alterado', sequence_left: 'Saída de sequência' }
const initial = (): RuleInput => ({ name: '', trigger: { type: '' }, event_filter: {}, condition: { match: 'all', groups: [] }, actions: [], frequency: 'always' })

export function RulesPage() {
  const { workspace = 'demo-workspace' } = useParams()
  return <RulesWorkspace key={workspace} workspace={workspace} />
}

function RulesWorkspace({ workspace }: { workspace: string }) {
  const result = useAsync(async () => {
    const [rules, settings, sequences, flows] = await Promise.all([listRules(), getSettings(workspace, ['fields', 'tags']), listSequences(workspace), listSequenceFlows(workspace)])
    return { rules, catalog: { tags: settings.items.filter(i => i.kind === 'tags' && !i.archived), fields: settings.items.filter(i => i.kind === 'fields' && i.scope === 'contact' && !i.archived), sequences, flows } satisfies RuleCatalog }
  }, workspace, { cache: `rules|${workspace}` })
  const [editor, setEditor] = React.useState<{ id?: string; input: RuleInput } | null>(null)
  const [deleting, setDeleting] = React.useState<Rule | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [search, setSearch] = React.useState('')
  const data = result.data ?? result.stale
  const opener = React.useRef<HTMLElement | null>(null)
  function open(rule?: Rule) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setError('')
    setEditor(rule ? { id: rule.id, input: { ...structuredClone(rule.draft), name: rule.name } } : { input: initial() })
  }
  function close() { setEditor(null); setError(''); requestAnimationFrame(() => opener.current?.focus()) }
  async function mutate(action: () => Promise<unknown>, message: string | (() => string)) {
    setError(''); setPending(true)
    try { await action(); setNotice(typeof message === 'function' ? message() : message); result.reload(); return true }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível salvar. Tente novamente.'); return false }
    finally { setPending(false) }
  }
  async function save(publish: boolean) {
    if (!editor) return
    const input = editor.input
    const problem = ruleProblem(input)
    if (problem) { setError(problem); return }
    let republished = false
    if (await mutate(async () => {
      const saved = await saveRule({ ...input, condition: input.condition?.groups.length ? input.condition : undefined }, editor.id)
      // Se a publicação falhar, a próxima tentativa atualiza o mesmo rascunho.
      setEditor(current => current ? { ...current, id: saved.id } : current)
      republished = !publish && (saved as { need_activate?: boolean }).need_activate === true
      if (publish || republished) await publishRule(saved.id)
    }, () => publish || republished ? 'Regra publicada e ativada.' : 'Rascunho salvo. A versão publicada continua valendo.')) close()
  }
  const patch = (input: Partial<RuleInput>) => setEditor(current => current ? { ...current, input: { ...current.input, ...input } } : null)
  const input = editor?.input
  const catalog = data?.catalog
  const rows = data?.rules.filter(r => r.name.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'))) ?? []

  return <div className="min-w-0 space-y-5">
    <title>Regras</title>
    <div className="min-w-0">
      <div className="min-w-0 space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          {editor ? <div className="flex min-w-0 items-center gap-2"><Button variant="ghost" size="icon" aria-label="Voltar para regras" disabled={pending} onClick={close}><ArrowLeft className="size-4" /></Button><h2 className="text-xl font-bold">{editor.id ? 'Editar regra' : 'Criar regra'}</h2></div> : <div><h2 className="text-xl font-bold">Regras</h2><p className="mt-1 text-sm text-text-muted">Reaja aos eventos dos seus contatos.</p></div>}
          {!editor && <div className="flex flex-wrap gap-2"><Button asChild variant="secondary"><Link to={`/${workspace}/automations/email-rules`}>Regras de e-mail</Link></Button><Button onClick={() => open()} disabled={!data || pending}><Plus className="size-4" aria-hidden="true" />Criar regra</Button></div>}
        </header>
        <p role="status" className="text-sm text-success">{notice}</p>
        {error && <Banner variant="danger">{error}</Banner>}
        {result.error ? <Banner variant="danger">Não foi possível carregar as regras e suas opções. <Button variant="secondary" size="sm" onClick={result.reload}>Tentar de novo</Button></Banner>
          : !data ? <div aria-busy="true" aria-label="Carregando regras" className="space-y-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-20 w-full" />)}</div>
          : input && catalog ? <form onSubmit={event => { event.preventDefault(); void save(false) }} className="space-y-6">
            <fieldset disabled={pending} className="min-w-0 space-y-6">
              <div className="max-w-xl space-y-1"><label htmlFor="rule-name" className="text-sm font-medium">Nome da regra</label><Input id="rule-name" maxLength={120} value={input.name} onChange={event => patch({ name: event.target.value })} autoFocus /></div>
              <div className="flex min-w-0 max-w-2xl flex-col gap-3">
                <div className="min-w-0 space-y-5">
                  <section aria-label="Quando executar" className="space-y-4 rounded-lg border border-border bg-surface p-5">
                    <h2 className="flex items-center gap-2 font-semibold"><Zap className="size-4 text-text-muted" aria-hidden="true" />Quando acontecer</h2>
                    <SelectField id="rule-trigger" label="Gatilho" value={input.trigger.type} onChange={type => patch({ trigger: { type: type as RuleConfig['trigger']['type'] }, event_filter: {} })} options={Object.entries(triggerNames).map(([id, name]) => ({ id, name }))} />
                    {(input.trigger.type === 'tag_added' || input.trigger.type === 'tag_removed') && <SelectField id="rule-event-tag" label="Tag do evento" value={input.event_filter?.tag_id ?? ''} onChange={tag_id => patch({ event_filter: { tag_id: tag_id || undefined } })} placeholder="Qualquer tag" options={catalog.tags} />}
                    {input.trigger.type === 'system_field_changed' && <>
                      <SelectField id="rule-event-system-field" label="Dado do contato" value={input.event_filter?.system_field ?? ''} onChange={system_field => patch({ event_filter: { system_field: (system_field || undefined) as SystemField | undefined } })} placeholder="Qualquer dado" options={Object.entries(systemFieldNames).map(([id, name]) => ({ id, name }))} />
                      <SelectField id="rule-event-system-comparison" label="Filtro do novo valor" value={input.event_filter?.operator ?? ''} onChange={operator => patch({ event_filter: { ...input.event_filter, operator: operator ? operator as 'equals' | 'contains' : undefined, value: operator ? '' : undefined } })} placeholder="Qualquer alteração" options={input.event_filter?.system_field ? [{ id: 'equals', name: 'Mudou para valor igual a' }, { id: 'contains', name: 'Novo valor contém' }] : []} />
                      {input.event_filter?.operator && input.event_filter.system_field && <div className="space-y-1"><label htmlFor="rule-event-system-value" className="text-sm">Valor do evento</label><Input id="rule-event-system-value" value={String(input.event_filter.value ?? '')} onChange={event => patch({ event_filter: { ...input.event_filter, value: event.target.value } })} /></div>}
                    </>}
                    {input.trigger.type === 'sequence_left' && <SelectField id="rule-event-sequence-left" label="Sequência da saída" value={input.event_filter?.sequence_id ?? ''} onChange={sequence_id => patch({ event_filter: { sequence_id: sequence_id || undefined } })} placeholder="Qualquer sequência" options={catalog.sequences} />}
                    {input.trigger.type === 'sequence_entered' && <SelectField id="rule-event-sequence" label="Sequência do evento" value={input.event_filter?.sequence_id ?? ''} onChange={sequence_id => patch({ event_filter: { sequence_id: sequence_id || undefined } })} options={catalog.sequences} />}
                    {input.trigger.type === 'field_changed' && <>
                      <SelectField id="rule-event-field" label="Campo do evento" value={input.event_filter?.field_id ?? ''} onChange={field_id => patch({ event_filter: { field_id: field_id || undefined } })} options={catalog.fields} />
                      <SelectField id="rule-event-comparison" label="Filtro do novo valor" value={input.event_filter?.operator ?? ''} onChange={operator => patch({ event_filter: { ...input.event_filter, operator: operator ? operator as 'equals' | 'contains' : undefined, value: operator ? '' : undefined } })} placeholder="Qualquer alteração" options={[{ id: 'equals', name: 'Mudou para valor igual a' }, ...(catalog.fields.find(f => f.id === input.event_filter?.field_id)?.field_type === 'text' ? [{ id: 'contains', name: 'Novo valor contém' }] : [])]} />
                      {input.event_filter?.operator && <RuleValue id="rule-event-value" label="Valor do evento" field={catalog.fields.find(f => f.id === input.event_filter?.field_id)} value={input.event_filter.value} onChange={value => patch({ event_filter: { ...input.event_filter, value } })} />}
                    </>}
                    {input.trigger.type === 'date' && <>
                      <SelectField id="rule-date-field" label="Campo de data" value={input.trigger.field_id ?? ''} onChange={field_id => patch({ trigger: { ...input.trigger, field_id } })} options={catalog.fields.filter(f => ['date', 'datetime'].includes(f.field_type))} />
                      <div className="space-y-1"><label htmlFor="rule-date-offset" className="text-sm">Minutos antes ou depois da data</label><Input id="rule-date-offset" type="number" value={(input.trigger.offset_seconds ?? 0) / 60} onChange={event => patch({ trigger: { ...input.trigger, offset_seconds: Number(event.target.value) * 60 } })} /><p className="text-xs text-text-muted">Use negativo para antes, zero para a própria data. O horário segue o fuso do contato.</p></div>
                      <div className="space-y-1"><label htmlFor="rule-date-time" className="text-sm">Horário fixo (opcional)</label><Input id="rule-date-time" type="time" value={input.trigger.at_time ?? ''} onChange={event => patch({ trigger: { ...input.trigger, at_time: event.target.value || undefined } })} /></div>
                      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-accent" checked={input.trigger.repeat_yearly ?? false} onChange={event => patch({ trigger: { ...input.trigger, repeat_yearly: event.target.checked } })} />Repetir a cada ano</label>
                    </>}
                    <RuleConditions condition={input.condition ?? { match: 'all', groups: [] }} catalog={catalog} onChange={condition => patch({ condition })} />
                  </section>
                </div>
                <ArrowDown className="mx-auto size-5 text-text-muted" aria-hidden="true" />
                <section aria-label="Ações da regra" className="min-w-0 space-y-3 rounded-lg border border-border bg-surface p-5">
                  <h2 className="flex items-center gap-2 font-semibold"><Play className="size-4 text-text-muted" aria-hidden="true" />Então executar</h2>
                  <SelectField id="rule-frequency" label="Frequência" value={input.frequency} onChange={frequency => patch({ frequency: frequency as 'once' | 'always' })} options={[{ id: 'always', name: 'A cada ocorrência' }, { id: 'once', name: 'Uma vez por contato' }]} />
                  {!input.actions.length && <p className="text-sm text-text-muted">Adicione uma ação para definir o que acontece com o contato.</p>}
                  {input.actions.map((action, index) => <RuleActionFields key={index} action={action} index={index} catalog={catalog} onChange={next => patch({ actions: input.actions.map((a, i) => index === i ? next : a) })} onRemove={() => patch({ actions: input.actions.filter((_, i) => i !== index) })} />)}
                  <Button type="button" variant="secondary" className="w-full border-dashed" disabled={input.actions.length >= 20} onClick={() => patch({ actions: [...input.actions, { type: 'add_tag', tag_id: '' }] })}><Plus className="size-4" aria-hidden="true" />Adicionar ação</Button>
                </section>
              </div>
                <p className="text-xs text-text-muted">Cada contato pode executar esta regra no máximo uma vez a cada 30 segundos. Alterações em lote não disparam regras.</p>
            </fieldset>
            <PageFooterBar><Button type="button" variant="ghost" disabled={pending} onClick={close}>Cancelar</Button><Button type="submit" variant="secondary" disabled={pending}>Salvar rascunho</Button><Button type="button" loading={pending} onClick={() => void save(true)}>Publicar regra</Button></PageFooterBar>
          </form>
          : <>
            <div className="relative max-w-sm"><Search className="pointer-events-none absolute top-3 left-3 size-4 text-text-muted" aria-hidden="true" /><Input aria-label="Buscar regra" placeholder="Buscar pelo nome" className="pl-9" value={search} onChange={event => setSearch(event.target.value)} /></div>
            {!rows.length ? <div className="rounded-lg border border-dashed border-border bg-surface px-5 py-12 text-center"><GitBranch className="mx-auto mb-4 size-8 text-text-muted" aria-hidden="true" /><h2 className="font-semibold">{search ? 'Nenhuma regra encontrada' : 'Crie uma resposta aos eventos do contato'}</h2><p className="mt-2 text-sm text-text-muted">{search ? 'Tente buscar por outro nome.' : 'Escolha um gatilho, defina as condições e adicione as ações.'}</p></div>
              : <div role="table" aria-label="Lista de regras" className="space-y-3">
                <div role="rowgroup"><div role="row" className={cn('hidden px-4 text-xs text-text-muted md:grid md:items-center md:gap-x-3', rowGrid)}><div role="columnheader">Estado</div><div role="columnheader">Regra</div><div role="columnheader" className="text-right">Execuções</div><div role="columnheader" className="text-right">Contatos únicos</div><div role="columnheader"><span className="sr-only">Ações</span></div></div></div>
                <div role="rowgroup" className="space-y-3">{rows.map(rule => <div role="row" key={rule.id} className={cn('grid min-h-[42px] grid-cols-[auto_auto_auto_1fr] items-center gap-x-3 gap-y-1 rounded-lg bg-surface px-4 py-1.5 shadow-card', rowGrid)}>
                  <div role="cell" className="order-2 col-span-1 flex items-center gap-2 md:order-none"><Switch aria-label={`Ativar ${rule.name}`} checked={rule.active} disabled={pending || !rule.published} onCheckedChange={active => void mutate(() => setRuleActive(rule.id, active), active ? 'Regra ativada.' : 'Regra pausada.')} /><span className={cn('text-xs', rule.active ? 'text-success' : 'text-text-muted')}>{rule.active ? 'Ativa' : rule.published ? 'Pausada' : 'Rascunho'}</span></div>
                  <div role="cell" className="order-1 col-span-full min-w-0 md:order-none md:col-span-1"><button type="button" className="break-words text-left text-sm font-semibold hover:underline" disabled={pending} onClick={() => open(rule)}>{rule.name}</button><p className="text-xs text-text-muted">{triggerNames[rule.draft.trigger.type as keyof typeof triggerNames] ?? 'Gatilho não definido'}{rule.published && JSON.stringify(rule.draft) !== JSON.stringify(rule.published) ? <span className="ml-2 text-warning">Alterações em rascunho</span> : null}</p></div>
                  <div role="cell" title="Execuções" className="order-3 text-right text-xs tabular-nums text-text-muted md:order-none md:text-sm md:text-text">{rule.executions.toLocaleString('pt-BR')}</div><div role="cell" title="Contatos únicos" className="order-4 text-right text-xs tabular-nums text-text-muted md:order-none md:text-sm md:text-text">{rule.unique_contacts.toLocaleString('pt-BR')}</div>
                  <div role="cell" className="order-5 flex justify-end md:order-none"><RowMenu item={rule.name}><RowMenuItem disabled={pending} onSelect={() => void mutate(() => duplicateRule(rule.id), 'Cópia criada como rascunho.')}>Duplicar</RowMenuItem><RowMenuItem className="text-danger" disabled={pending} onSelect={() => { setError(''); setDeleting(rule) }}>Excluir</RowMenuItem></RowMenu></div>
                </div>)}</div>
              </div>}
          </>}
      </div>
    </div>
    <Dialog open={!!deleting} onOpenChange={open => { if (!open && !pending) setDeleting(null) }}><DialogContent><DialogTitle>Excluir regra?</DialogTitle><DialogDescription>A regra {deleting?.name} será removida. As ações já realizadas nos contatos serão preservadas.</DialogDescription>{error && <Banner variant="danger">{error}</Banner>}<div className="flex justify-end gap-2"><Button variant="secondary" disabled={pending} onClick={() => setDeleting(null)}>Cancelar</Button><Button loading={pending} onClick={async () => { if (deleting && await mutate(() => deleteRule(deleting.id), 'Regra excluída.')) setDeleting(null) }}>Excluir regra</Button></div></DialogContent></Dialog>
  </div>
}

function RuleActionFields({ action, index, catalog, onChange, onRemove }: { action: RuleAction; index: number; catalog: RuleCatalog; onChange: (action: RuleAction) => void; onRemove: () => void }) {
  const n = index + 1
  function changeType(type: string) {
    if (type === 'add_tag' || type === 'remove_tag') onChange({ type, tag_id: '' })
    else if (type === 'add_to_sequence' || type === 'remove_from_sequence') onChange({ type, sequence_id: '' })
    else if (type === 'start_automation') onChange({ type, automation_id: '' })
    else if (type === 'unset_custom_field_value') onChange({ type, field_id: '' })
    else onChange({ type: 'set_custom_field_value', field_id: '', value: '' })
  }
  const Icon = actionIcons[action.type] ?? Tag
  return <div role="group" aria-label={`Ação ${n}`} className="min-w-0 space-y-3 rounded-lg border border-border bg-surface-muted p-3">
    <div className="flex items-center gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"><Icon className="size-4" aria-hidden="true" /></span><p className="min-w-0 flex-1 truncate text-sm font-semibold">{actionSummary(action, catalog)}</p><Button type="button" size="icon" variant="ghost" aria-label={`Remover ação ${n}`} onClick={onRemove}><Trash2 className="size-4" aria-hidden="true" /></Button></div>
    <SelectField id={`rule-action-type-${n}`} hideLabel label={`Tipo da ação ${n}`} value={action.type} onChange={changeType} options={actionTypes} />
    {'tag_id' in action && <SelectField id={`rule-action-tag-${n}`} hideLabel label={`Tag da ação ${n}`} value={action.tag_id} onChange={tag_id => onChange({ ...action, tag_id })} options={catalog.tags} />}
    {'sequence_id' in action && <SelectField id={`rule-action-sequence-${n}`} hideLabel label={`Sequência da ação ${n}`} value={action.sequence_id} onChange={sequence_id => onChange({ ...action, sequence_id })} options={catalog.sequences} />}
    {'automation_id' in action && <SelectField id={`rule-action-flow-${n}`} hideLabel label={`Automação da ação ${n}`} value={action.automation_id} onChange={automation_id => onChange({ ...action, automation_id })} options={catalog.flows.filter(flow => flow.published)} />}
    {'field_id' in action && <SelectField id={`rule-action-field-${n}`} hideLabel label={`Campo da ação ${n}`} value={action.field_id} onChange={field_id => onChange({ ...action, field_id, ...(action.type === 'set_custom_field_value' ? { value: '' } : {}) })} options={catalog.fields} />}
    {action.type === 'set_custom_field_value' && <RuleValue id={`rule-action-value-${n}`} label={`Valor da ação ${n}`} field={catalog.fields.find(f => f.id === action.field_id)} value={action.value} onChange={value => onChange({ ...action, value })} />}
  </div>
}

const actionTypes = [{ id: 'add_tag', name: 'Aplicar tag' }, { id: 'remove_tag', name: 'Remover tag' }, { id: 'set_custom_field_value', name: 'Definir campo' }, { id: 'unset_custom_field_value', name: 'Limpar campo' }, { id: 'add_to_sequence', name: 'Inscrever em sequência' }, { id: 'remove_from_sequence', name: 'Cancelar sequência' }, { id: 'start_automation', name: 'Iniciar automação' }]
const actionIcons: Record<string, LucideIcon> = { add_tag: Tag, remove_tag: Tags, set_custom_field_value: PenLine, unset_custom_field_value: Eraser, add_to_sequence: ListPlus, remove_from_sequence: ListMinus, start_automation: Play }
function actionSummary(action: RuleAction, catalog: RuleCatalog) {
  const label = actionTypes.find(t => t.id === action.type)?.name ?? 'Ação'
  const target = 'tag_id' in action ? catalog.tags.find(t => t.id === action.tag_id)?.name
    : 'sequence_id' in action ? catalog.sequences.find(t => t.id === action.sequence_id)?.name
    : 'automation_id' in action ? catalog.flows.find(t => t.id === action.automation_id)?.name
    : 'field_id' in action ? catalog.fields.find(t => t.id === action.field_id)?.name : undefined
  return target ? `${label} · ${target}` : label
}
