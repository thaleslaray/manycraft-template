import * as React from "react"
import { Link, useNavigate, useParams } from "react-router"
import { ArrowDown, ArrowUp, Pencil, Trash2, X } from "lucide-react"
import { createSequence, formatSequenceDelay, listSequenceFlows, listSequences, sequenceDelayUnit, updateSequence, type Sequence, type SequenceFlow, type SequenceInput, type SequenceStep } from "@/data/sequences"
import { createAutomation } from "@/data/index"
import { useAsync } from "@/hooks/use-async"
import { cn } from "@/lib/utils"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { AutomationPicker } from "@/components/automations/automation-picker"
import { FieldSelect } from "@/components/ui/field-select"
import { PageHeader } from "@/components/shell/page-header"
import { percent } from "./sequence-metrics"

const weekdays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"]
const weekdayNames = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"]
type Crumbs = { label: string; to: string }[]

/** Página própria da sequência: `/automations/sequences/new` cria, `/automations/sequences/:sequenceId` edita. Fica fora da moldura de Automação, como no original. */
export function SequenceEditPage() {
  const { workspace = "demo", sequenceId = "new" } = useParams()
  // Ao criar, o endereço troca de "new" para o id novo; a tela é a mesma e não recarrega nem perde o que o usuário digitou.
  const [criada, setCriada] = React.useState<string | null>(null)
  const estavel = sequenceId === criada ? "new" : sequenceId
  const result = useAsync(async () => ({ sequences: await listSequences(workspace), flows: await listSequenceFlows(workspace) }), `${workspace}:${estavel}`)
  const back = `/${workspace}/automations/sequences`
  const crumbs: Crumbs = [{ label: "Automação", to: `/${workspace}/automations` }, { label: "Sequências", to: back }]
  const sequence = estavel === "new" ? null : result.data?.sequences.find(item => item.id === sequenceId) ?? null
  return <div className="min-w-0 space-y-4">
    <title>{sequence ? `Editar ${sequence.name}` : "Nova sequência"}</title>
    {result.error ? <><PageHeader title="Sequência" crumbs={crumbs} /><Banner variant="danger"><p>Não foi possível carregar a sequência.</p><Button variant="secondary" size="sm" onClick={result.reload}>Tentar de novo</Button></Banner></>
      : !result.data ? <><PageHeader title="Sequência" crumbs={crumbs} /><div role="status" aria-label="Carregando sequência"><Skeleton className="h-64 w-full" /></div></>
      : estavel !== "new" && !sequence ? <><PageHeader title="Sequência" crumbs={crumbs} /><Banner variant="danger">Sequência não encontrada. Ela pode ter sido excluída.</Banner></>
      : <SequenceEditor key={estavel} sequence={sequence} flows={result.data.flows} workspace={workspace} crumbs={crumbs} onCreated={setCriada} />}
  </div>
}

const metricCell = "w-16 text-right tabular-nums"

function SequenceEditor({ sequence, flows, workspace, crumbs, onCreated }: { sequence: Sequence | null; flows: SequenceFlow[]; workspace: string; crumbs: Crumbs; onCreated: (id: string) => void }) {
  const back = `/${workspace}/automations/sequences`
  const [schedules, setSchedules] = React.useState<string[]>([])
  const [availableFlows, setAvailableFlows] = React.useState(flows)
  const [draft, setDraft] = React.useState<SequenceInput>(() => ({ name: sequence?.name ?? "", steps: structuredClone(sequence?.steps ?? []) }))
  const [error, setError] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [saveState, setSaveState] = React.useState<"saved" | "saving" | "pending" | "failed">("saved")
  const navigate = useNavigate()
  const id = React.useId()
  const pickerFlows = React.useMemo(() => availableFlows.map(flow => ({ id: flow.id, name: flow.name, published_version_id: flow.published ? flow.id : null })), [availableFlows])
  // Salvamento automático: cada mudança espera uma pausa curta e grava; a fila garante uma gravação por vez e a última vence.
  const savedId = React.useRef(sequence?.id ?? null)
  const lastSaved = React.useRef(JSON.stringify(draft))
  const queue = React.useRef<Promise<unknown>>(Promise.resolve())
  const latest = React.useRef(draft)
  latest.current = draft

  const persist = React.useCallback((next: SequenceInput) => {
    const snapshot = JSON.stringify(next)
    const run = queue.current.catch(() => undefined).then(async () => {
      if (snapshot === lastSaved.current) return
      if (savedId.current) await updateSequence(workspace, savedId.current, next)
      else {
        const created = await createSequence(workspace, next)
        savedId.current = created.id
        onCreated(created.id)
        navigate(`${back}/${created.id}`, { replace: true })
      }
      lastSaved.current = snapshot
    })
    queue.current = run
    return run
  }, [workspace, back, navigate, onCreated])

  React.useEffect(() => {
    if (JSON.stringify(draft) === lastSaved.current) { setSaveState(current => current === "failed" ? current : "saved"); return }
    if (!draft.name.trim()) { setSaveState("pending"); return }
    setSaveState("pending")
    const timer = setTimeout(() => {
      setSaveState("saving")
      persist(draft).then(() => { setError(""); setSaveState(JSON.stringify(latest.current) === lastSaved.current ? "saved" : "pending") })
        .catch(reason => { setError(reason instanceof Error ? reason.message : "Não foi possível salvar. Tente de novo."); setSaveState("failed") })
    }, 700)
    return () => clearTimeout(timer)
  }, [draft, persist])
  // Sair da página com uma mudança ainda esperando a pausa grava antes de ir embora.
  React.useEffect(() => () => { if (JSON.stringify(latest.current) !== lastSaved.current && latest.current.name.trim()) void persist(latest.current).catch(() => undefined) }, [persist])

  function patchStep(index: number, patch: Partial<SequenceStep>) {
    setDraft((current) => ({ ...current, steps: current.steps.map((step, i) => i === index ? { ...step, ...patch } : step) }))
    setError("")
  }

  function moveStep(index: number, direction: number) {
    setDraft((current) => {
      const steps = [...current.steps]
      ;[steps[index], steps[index + direction]] = [steps[index + direction], steps[index]]
      return { ...current, steps }
    })
  }

  async function newReply(index: number) {
    if (!draft.name.trim()) { setError("Dê um nome à sequência antes de criar a resposta."); return }
    setSaving(true)
    setError("")
    let next = draft
    try {
      const automation = await createAutomation(workspace, `Resposta ${index + 1} · ${draft.name}`.slice(0, 120))
      next = { ...draft, steps: draft.steps.map((step, i) => i === index ? { ...step, automation_id: automation.id, status: "draft" as const } : step) }
      // Preserva o vínculo também se o salvamento falhar: tentar de novo não cria outra automação.
      setDraft(next)
      setAvailableFlows(current => [...current, { id: automation.id, name: automation.name, published: false }])
      await persist(next)
      navigate(`/${workspace}/automations/${automation.id}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível preparar a resposta. Tente novamente.")
      setSaving(false)
    }
  }

  async function retry() {
    setSaveState("saving"); setError("")
    try { await persist(draft); setSaveState("saved") } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível salvar. Tente de novo."); setSaveState("failed") }
  }

  const nameField = <span className="flex min-w-0 items-center gap-2 border-b border-border"><input id={`${id}-name`} aria-label="Nome da sequência" required maxLength={120} placeholder="Nome da sequência" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="min-w-0 flex-1 bg-transparent py-0.5 text-lg font-bold outline-none placeholder:font-normal placeholder:text-text-muted sm:text-2xl" /><Pencil className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" /></span>
  const timeline = "md:grid-cols-[9.5rem_1.5rem_minmax(0,1fr)]"
  const statusText = saveState === "saved" ? (savedId.current ? "Salvo" : "") : saveState === "saving" ? "Salvando…" : saveState === "failed" ? "Não salvo" : draft.name.trim() ? "Salvando…" : "Dê um nome para salvar"
  const status = statusText ? <span role="status" className={cn("text-sm", saveState === "failed" ? "text-danger" : "text-text-muted")}>{statusText}</span> : null

  return <div className="min-w-0 space-y-4 pb-4">
    <PageHeader title={draft.name || "Nova sequência"} titleSlot={nameField} crumbs={crumbs} status={status} />
    <div className={cn("grid gap-x-4", timeline)}><div className="hidden md:block" /><div className="md:col-span-2"><Banner variant="info" className="border border-border py-3"><span className="text-text-muted">A mensagem inicial de qualquer sequência não deve conter anúncios ou materiais promocionais.</span></Banner></div></div>
    <div className={cn("mt-6 hidden items-end gap-x-4 text-xs text-text-muted md:grid", timeline)} aria-hidden="true">
      <div className="pr-2 text-right">Agendamento</div><div />
      <div className="flex min-w-0 items-end px-4"><span className="flex-1">Ativo</span><span className={metricCell}>Enviado</span><span className={metricCell}>Cliques</span><span className="w-24 whitespace-nowrap text-right">Taxa de abertura</span><span className="w-14 text-right">CTR</span><span className="w-8" /></div>
    </div>
    <div className="space-y-2">
      {draft.steps.length === 0 ? <p className="rounded-lg border border-dashed border-border p-4 text-sm text-text-muted">Ainda não há mensagens. Adicione a primeira com “+ Mensagem”.</p> : null}
      {draft.steps.map((step, index) => {
        const window = step.sending_time_settings
        const flow = availableFlows.find((item) => item.id === step.automation_id)
        const open = schedules.includes(step.id)
        const state = step.status === "live" ? "Ao vivo" : "Rascunho"
        return <div key={step.id} role="group" aria-label={`Passo ${index + 1}`} className={cn("group grid min-w-0 gap-x-4 gap-y-1", timeline)}>
          <div className="flex items-start md:justify-end md:pr-2 md:pt-3"><button type="button" aria-label={`Editar agendamento do passo ${index + 1}`} aria-expanded={open} disabled={saving} onClick={() => setSchedules(current => current.includes(step.id) ? current.filter(value => value !== step.id) : [...current, step.id])} className="border-b border-border text-xs text-text-muted hover:text-text md:text-right">{scheduleSummary(step)}</button></div>
          <div className="relative hidden md:block" aria-hidden="true"><span className="absolute -inset-y-1.5 left-1/2 w-px bg-border" /><span className="absolute left-1/2 top-4 size-3 -translate-x-1/2 rounded-full border-2 border-bg bg-border" /></div>
          <div className={cn("min-w-0 rounded-lg bg-surface px-4 py-3 shadow-card", !step.automation_id && "min-h-[3.75rem]")}>
            <div className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2">
              <Switch aria-label="Enviar este passo" id={`${id}-${step.id}-live`} className="mt-0.5" title={!flow?.published ? "Vincule uma automação publicada para ativar o envio" : undefined} checked={step.status === "live"} disabled={saving || !flow?.published} onCheckedChange={(checked) => patchStep(index, { status: checked ? "live" : "draft" })} />
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 pt-0.5 text-sm">
                {step.automation_id ? <>
                  <span className="text-text-muted">Enviar</span>
                  <Link className="min-w-0 truncate font-medium hover:underline" to={`/${workspace}/automations/${step.automation_id}`}>{flow?.name ?? "Automação"}<span className="sr-only"> (Editar resposta)</span></Link>
                  <span title={state} className={cn("size-2.5 shrink-0 rounded-full", step.status === "live" ? "bg-success" : "bg-warning")}><span className="sr-only">{state}</span></span>
                  <Button type="button" size="icon" variant="ghost" className="size-7 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100" disabled={saving} aria-label={`Remover automação do passo ${index + 1}`} onClick={() => patchStep(index, { automation_id: null, status: "draft" })}><X className="size-3.5" aria-hidden="true" /></Button>
                </> : <>
                  <Button type="button" size="sm" variant="secondary" disabled={saving} onClick={() => newReply(index)}>Criar nova resposta</Button>
                  <AutomationPicker workspace={workspace} automations={pickerFlows} value="" existingLabel="Selecionar existente" onlyPublished={false} disabled={saving} clearLabel={`Remover automação do passo ${index + 1}`} onChange={(automation_id) => patchStep(index, { automation_id: automation_id || null, ...(!availableFlows.find((item) => item.id === automation_id)?.published ? { status: "draft" as const } : {}) })} />
                </>}
              </div>
              <div role="group" aria-label={`Estatísticas do passo ${index + 1}`} className="flex flex-wrap items-center gap-x-4 pt-1 text-sm text-text-muted md:gap-0">
                {([["Enviados", step.stats?.sent ?? 0, metricCell], ["Cliques", step.stats?.clicked ?? 0, metricCell], ["Taxa de abertura", percent(step.stats?.open_rate), "w-24 text-right tabular-nums"], ["CTR", percent(step.stats?.ctr), "w-14 text-right tabular-nums"]] as const).map(([label, value, cls]) => <span key={label} className={cn(cls, "max-md:w-auto")}><span className="md:sr-only">{label}: </span>{value.toLocaleString("pt-BR")}</span>)}
              </div>
              <div className="flex w-8 shrink-0 justify-end">
                <Button type="button" size="icon" variant="ghost" className="size-7" disabled={saving} aria-label={`Remover passo ${index + 1}`} onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })}><Trash2 className="size-3.5" aria-hidden="true" /></Button>
              </div>
            </div>
            {!step.automation_id ? <p className="sr-only">Este passo pode ficar como rascunho. Vincule uma automação para ativar o envio.</p> : !flow?.published ? <p className="mt-2 text-xs text-warning">A automação ainda não tem uma versão publicada. Este passo permanece em rascunho.</p> : null}
            {open ? <div className="mt-3 space-y-4 rounded-md bg-surface-muted p-3">
              <SequenceDelayFields id={`${id}-${step.id}`} seconds={step.delay_seconds} onChange={(delay_seconds) => patchStep(index, { delay_seconds })} />
              <FieldSelect id={`${id}-${step.id}-window`} label="Janela de envio" value={window.type} options={[{ value: "all", label: "Qualquer horário e dia" }, { value: "timelimit", label: "Escolher horários e dias" }]} onChange={(type) => patchStep(index, { sending_time_settings: type === "all" ? { type: "all" } : { type: "timelimit", from: "09:00", to: "18:00", weekdays: [1, 2, 3, 4, 5] } })} />
              {window.type === "timelimit" ? <div className="space-y-3"><div className="grid grid-cols-2 gap-3"><FieldSelect id={`${id}-${step.id}-from`} label="A partir de" value={window.from} options={Array.from({ length: 24 }, (_, hour) => { const time = `${String(hour).padStart(2, "0")}:00`; return { value: time, label: time } })} onChange={(from) => patchStep(index, { sending_time_settings: { ...window, from } })} /><FieldSelect id={`${id}-${step.id}-to`} label="Até" value={window.to} options={Array.from({ length: 24 }, (_, hour) => { const time = `${String(hour + 1).padStart(2, "0")}:00`; return { value: time, label: time } })} onChange={(to) => patchStep(index, { sending_time_settings: { ...window, to } })} /></div><fieldset><legend className="mb-2 text-sm">Dias permitidos</legend><div className="flex flex-wrap gap-3">{weekdays.map((day, dayIndex) => <label key={day} className="flex items-center gap-1 text-xs"><input type="checkbox" aria-label={`${weekdayNames[dayIndex]} no passo ${index + 1}`} checked={window.weekdays.includes(dayIndex)} onChange={(event) => patchStep(index, { sending_time_settings: { ...window, weekdays: event.target.checked ? [...window.weekdays, dayIndex].sort() : window.weekdays.filter((value) => value !== dayIndex) } })} className="size-4 accent-accent" />{day}</label>)}</div></fieldset></div> : null}
              {window.type === "timelimit" && window.weekdays.length < 7 ? <p className="text-xs text-warning">Dias desmarcados podem adiar este passo até a próxima janela permitida.</p> : null}
              <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="secondary" disabled={saving || index === 0} onClick={() => moveStep(index, -1)}><ArrowUp className="size-3.5" aria-hidden="true" />Mover passo {index + 1} para cima</Button><Button type="button" size="sm" variant="secondary" disabled={saving || index === draft.steps.length - 1} onClick={() => moveStep(index, 1)}><ArrowDown className="size-3.5" aria-hidden="true" />Mover passo {index + 1} para baixo</Button></div>
            </div> : null}
          </div>
        </div>
      })}
      <div className={cn("grid gap-x-4 pt-1", timeline)}><div className="hidden md:block" /><div className="md:col-span-2 md:-ml-3"><Button type="button" size="sm" variant="secondary" className="bg-surface" disabled={saving} onClick={() => setDraft({ ...draft, steps: [...draft.steps, { id: `step-${crypto.randomUUID()}`, delay_seconds: 0, sending_time_settings: { type: "all" }, status: "draft", automation_id: null }] })}>+ Mensagem</Button></div></div>
    </div>
    <p className="text-xs text-warning">As alterações são salvas sozinhas; passos já elegíveis poderão sair imediatamente, respeitando a janela e os dias permitidos.</p>
    {error ? <Banner variant="danger">{error} <Button type="button" variant="secondary" size="sm" disabled={saving || saveState === "saving"} onClick={() => void retry()}>Tentar de novo</Button></Banner> : null}
  </div>
}

function SequenceDelayFields({ id, seconds, onChange }: { id: string; seconds: number; onChange: (seconds: number) => void }) {
  const [unit, setUnit] = React.useState(() => sequenceDelayUnit(seconds).unit)
  const value = seconds / unit
  return <div className="grid grid-cols-2 gap-3">
    <div className="space-y-1"><label htmlFor={`${id}-delay`} className="text-sm">Intervalo</label><Input id={`${id}-delay`} type="number" required min={0} max={99999} step={1} value={value} onChange={(event) => onChange(Number(event.target.value) * unit)} /></div>
    <FieldSelect id={`${id}-unit`} label="Unidade" value={String(unit)} options={[{ value: "1", label: "Segundos" }, { value: "60", label: "Minutos" }, { value: "3600", label: "Horas" }, { value: "86400", label: "Dias" }]} onChange={(next) => { const nextUnit = Number(next); setUnit(nextUnit); onChange(value * nextUnit) }} />
  </div>
}

function scheduleSummary(step: SequenceStep): string {
  const delay = step.delay_seconds ? `Após ${formatSequenceDelay(step.delay_seconds)}` : "Sem espera"
  const window = step.sending_time_settings
  return window.type === "all" ? delay : `${delay} · ${window.from}–${window.to} · ${window.weekdays.length === 7 ? "Qualquer dia" : [...window.weekdays].sort().map(day => weekdays[day]).join(", ")}`
}
