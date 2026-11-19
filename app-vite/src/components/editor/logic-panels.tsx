import { useAsync } from "@/hooks/use-async"
import { apiRequest, isFakeMode } from "@/data/api"
import { TimeWindowControls, TimezoneControl, DateSourceControls, OffsetControls } from "./temporal-controls"
import { dateFields, originOptions } from "./temporal"
import * as React from "react"
import { emailFilters, emailSystemFields, emailOperatorsFor, isDateSystemField, systemFieldChoices, type EmailFilter } from "./email-condition"
import { newRule, ruleGroups, ruleOptionId } from "./condition-catalog"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SidePanel } from "@/components/ui/side-panel"
import { Skeleton } from "@/components/ui/skeleton"
import { NodeErrors, NodeLinks, type PanelProps } from "./panel-shared"
import { NumberedStep } from "@/components/ui/numbered-step"
import { botOperatorsFor, fieldOperators, getRules, getVariations, initialFieldValue, needsValue, newId, operatorsFor, type ConditionRule, type EditorField } from "./graph"

export function Choice({ id, label, hideLabel, value, disabled, options, groups, onChange, placeholder = "Escolha uma opção" }: {
  id: string; label: string; hideLabel?: boolean; value: string; disabled?: boolean; options: { id: string; name: string }[]; groups?: { label: string; options: { id: string; name: string }[] }[]; onChange: (value: string) => void; placeholder?: string
}) {
  const missing = value && !options.some(o => o.id === value)
  return <div className="min-w-0 space-y-1">
    <Label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>{label}</Label>
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full min-w-0 [&>span:first-child]:truncate" title={options.find(o => o.id === value)?.name}><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent className="w-(--radix-select-trigger-width)">
        {missing ? <SelectItem value={value}>Referência indisponível</SelectItem> : null}
        {groups ? groups.map(g => <SelectGroup key={g.label}><SelectLabel>{g.label}</SelectLabel>{g.options.map(o => <SelectItem key={o.id} value={o.id} className="h-auto min-h-9 break-words py-2">{o.name}</SelectItem>)}</SelectGroup>)
          : options.map(o => <SelectItem key={o.id} value={o.id} className="h-auto min-h-9 break-words py-2">{o.name}</SelectItem>)}
      </SelectContent>
    </Select>
    {!options.length ? <p className="text-xs text-text-muted">Nenhuma opção disponível neste espaço.</p> : null}
  </div>
}

/** Valores continuam tipados em JSON, inclusive false, zero e texto vazio. */
export function FieldValue({ id, field, value, disabled, onChange }: {
  id: string; field?: EditorField; value: unknown; disabled?: boolean; onChange: (value: unknown) => void
}) {
  const serialized = typeof value === "object" ? JSON.stringify(value) : String(value ?? "")
  const [raw, setRaw] = React.useState(serialized)
  React.useEffect(() => { setRaw(serialized) }, [serialized, field?.id])
  if (field?.type === "boolean") return <Choice id={id} label="Valor" value={String(value)} disabled={disabled} options={[{ id: "true", name: "Verdadeiro" }, { id: "false", name: "Falso" }]} onChange={v => onChange(v === "true")} />
  return <div className="space-y-1">
    <Label htmlFor={id}>Valor {field?.type === "array" ? "(lista JSON)" : field?.type === "datetime" ? "(data e hora ISO, com fuso)" : ""}</Label>
    <Input id={id} disabled={disabled || !field} type={field?.type === "number" ? "number" : field?.type === "date" ? "date" : "text"}
      step={field?.type === "number" ? "any" : undefined} value={raw} onChange={e => {
        const text = e.target.value
        setRaw(text)
        if (field?.type === "number") onChange(text.trim() && Number.isFinite(Number(text)) ? Number(text) : text)
        else if (field?.type === "array") { try { onChange(JSON.parse(text)) } catch { onChange(text) } }
        else onChange(text)
      }} />
    {field?.type === "datetime" ? <p className="text-xs text-text-muted">Exemplo: 2026-10-23T14:30:00-03:00</p> : null}
  </div>
}

export function CatalogNotice({ p, kind }: { p: PanelProps; kind: "fields" | "automations" | "segments" | "sequences" | "members" | "connections" }) {
  if (p.catalogLoading) return <div role="status" aria-label="Carregando opções" className="space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-10 w-full" /></div>
  if (!p.catalogErrors?.[kind]) return null
  return <div role="alert" className="space-y-2 rounded-md bg-warning-soft p-3 text-sm">
    <p>{kind === "fields" ? "Não foi possível listar os campos de contato." : kind === "segments" ? "Não foi possível listar os segmentos." : kind === "sequences" ? "Não foi possível listar as sequências." : kind === "members" ? "Não foi possível listar a equipe." : kind === "connections" ? "Não foi possível listar as conexões." : "Não foi possível listar as automações."}</p>
    <Button variant="secondary" size="sm" onClick={p.reloadCatalogs}>Tentar de novo</Button>
  </div>
}

export function ConditionPanel(p: PanelProps) {
  const rules = getRules(p.node.data.config)
  const fields = p.fields ?? []
  const set = (next: ConditionRule[]) => p.updateConfig({ rules: next })
  const change = (i: number, rule: ConditionRule) => set(rules.map((r, j) => i === j ? rule : r))
  const groups = React.useMemo(ruleGroups, [])
  const botFields = p.botFields ?? []
  return <SidePanel title="Verificar condição" tone="action" onClose={p.onClose}>
    <NodeErrors errors={p.errors} show={p.showErrors} />
    <NumberedStep n={1} title="Como combinar as regras">
      <Choice id="condition-match" label="Quando seguir pelo caminho positivo" value={String(p.node.data.config.match ?? "")} disabled={p.readOnly}
        options={[{ id: "all", name: "Quando todas as regras forem atendidas" }, { id: "any", name: "Quando alguma regra for atendida" }]} onChange={match => p.updateConfig({ match })} />
    </NumberedStep>
    <CatalogNotice p={p} kind="fields" />
    {rules.some(rule => rule.type === "segment") ? <CatalogNotice p={p} kind="segments" /> : null}
    {!rules.length ? <p className="text-text-muted">Adicione uma regra para separar os caminhos.</p> : null}
    <ol aria-label="Regras da condição" className="space-y-6">
      {rules.map((rule, i) => {
        const field = rule.type === "field" ? fields.find(f => f.id === rule.field_id) : undefined
        return <li key={i}><NumberedStep n={i + 2} title={`Verificar a regra ${i + 1}`}><div className="space-y-3">
          <Choice id={`rule-type-${i}`} label={`Regra ${i + 1}`} value={ruleOptionId(rule)} disabled={p.readOnly} options={groups.flatMap(g => g.options)} groups={groups} onChange={option => change(i, newRule(option))} />
          {rule.type === "sequence" ? <>
            <CatalogNotice p={p} kind="sequences" />
            <Choice id={`rule-sequence-${i}`} label="Sequência" value={rule.sequence_id} disabled={p.readOnly || p.catalogLoading || p.catalogErrors?.sequences} options={p.sequences ?? []} onChange={sequence_id => change(i, { ...rule, sequence_id })} />
            <Choice id={`rule-operator-${i}`} label="Comparação" value={rule.operator} disabled={p.readOnly} options={[{ id: "has", name: "Pertence à sequência" }, { id: "not_has", name: "Não pertence à sequência" }]} onChange={operator => change(i, { ...rule, operator: operator as "has" | "not_has" })} />
          </> : rule.type === "origin" ? <>
            <Choice id={`rule-origin-${i}`} label="Origem" value={rule.origin} disabled={p.readOnly} options={originOptions} onChange={origin => change(i, { ...rule, origin })} />
            <Choice id={`rule-operator-${i}`} label="Comparação" value={rule.operator} disabled={p.readOnly} options={[{ id: "is", name: "Veio dessa origem" }, { id: "is_not", name: "Não veio dessa origem" }]} onChange={operator => change(i, { ...rule, operator: operator as "is" | "is_not" })} />
            <p className="text-xs text-text-muted">A origem é o gatilho da primeira passagem do contato por uma automação. Contato que nunca passou por uma não tem origem.</p>
          </> : rule.type === "current_time" ? <>
            <TimeWindowControls id={`rule-window-${i}`} value={rule.window} disabled={p.readOnly} onChange={window => change(i, { ...rule, window })} />
            <TimezoneControl id={`rule-timezone-${i}`} value={rule.timezone} disabled={p.readOnly} onChange={timezone => change(i, { ...rule, timezone })} />
          </> : rule.type === "date" ? <>
            <Choice id={`rule-field-${i}`} label="Campo de data" value={rule.field_id} disabled={p.readOnly} options={dateFields(fields)} onChange={field_id => change(i, { ...rule, field_id })} />
            <Choice id={`rule-operator-${i}`} label="Comparação" value={rule.operator} disabled={p.readOnly} options={[{ id: "before", name: "Antes de" }, { id: "after", name: "Depois de" }, { id: "equals", name: "Na mesma data" }]} onChange={operator => change(i, { ...rule, operator: operator as "before" | "after" | "equals" })} />
            <DateSourceControls id={`rule-date-${i}`} source={rule.compare} fields={fields.filter(f => f.type === fields.find(item => item.id === rule.field_id)?.type)} disabled={p.readOnly} comparison onChange={compare => change(i, { ...rule, compare })} />
            <OffsetControls id={`rule-offset-${i}`} value={rule.offset} disabled={p.readOnly} onChange={offset => change(i, { ...rule, offset })} />
            <TimezoneControl id={`rule-timezone-${i}`} value={rule.timezone} disabled={p.readOnly} contact onChange={timezone => change(i, { ...rule, timezone })} />
          </> : rule.type === "tag" ? <>
            <Choice id={`rule-tag-${i}`} label="Tag" value={rule.tag_id} disabled={p.readOnly} options={p.tags} onChange={tag_id => change(i, { ...rule, tag_id })} />
            <Choice id={`rule-operator-${i}`} label="Comparação" value={rule.operator} disabled={p.readOnly} options={[{ id: "has", name: "Possui a tag" }, { id: "not_has", name: "Não possui a tag" }]} onChange={operator => change(i, { ...rule, operator: operator as "has" | "not_has" })} />
          </> : rule.type === "topic" ? <>
            <TopicRule value={rule.topic_id ?? ""} disabled={p.readOnly} onChange={topic_id => change(i, { ...rule, topic_id: topic_id || undefined })} />
            <Choice id={`rule-operator-${i}`} label="Comparação" value={rule.operator} disabled={p.readOnly} options={[{ id: "has", name: "Tem inscrição válida" }, { id: "not_has", name: "Não tem inscrição válida" }]} onChange={operator => change(i, { ...rule, operator: operator as "has" | "not_has" })} />
          </> : rule.type === "any_tag" ? <>
            <fieldset className="space-y-1" disabled={p.readOnly}><legend className="text-sm font-medium">Tags (basta uma)</legend>
              <div className="flex flex-wrap gap-2">{p.tags.map(t => <label key={t.id} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm">
                <input type="checkbox" className="accent-accent" checked={rule.tag_ids.includes(t.id)} onChange={e => change(i, { ...rule, tag_ids: e.target.checked ? [...rule.tag_ids, t.id] : rule.tag_ids.filter(x => x !== t.id) })} />{t.name}</label>)}</div></fieldset>
            <Choice id={`rule-operator-${i}`} label="Comparação" value={rule.operator} disabled={p.readOnly} options={[{ id: "has", name: "Possui alguma" }, { id: "not_has", name: "Não possui nenhuma" }]} onChange={operator => change(i, { ...rule, operator: operator as "has" | "not_has" })} />
          </> : rule.type === "segment" ? <>
            <Choice id={`rule-segment-${i}`} label="Segmento salvo" value={rule.segment_id} disabled={p.readOnly || p.catalogLoading} options={p.segments ?? []} onChange={segment_id => change(i, { ...rule, segment_id })} />
            <Choice id={`rule-operator-${i}`} label="Comparação" value={rule.operator === "has" ? "in" : rule.operator === "not_has" ? "not_in" : rule.operator} disabled={p.readOnly} options={[{ id: "in", name: "Pertence ao segmento" }, { id: "not_in", name: "Não pertence ao segmento" }]} onChange={operator => change(i, { ...rule, operator: operator as "in" | "not_in" })} />
            <p className="text-xs text-text-muted">O motor verifica as regras atuais do segmento quando o contato chega a este passo.</p>
          </> : rule.type === "email" ? <Choice id={`rule-email-${i}`} label="Condição de e-mail" value={rule.filter} disabled={p.readOnly} options={[...emailFilters]} onChange={filter => change(i, {...rule,filter:filter as EmailFilter})} /> : rule.type === "system_field" ? <>
            <p className="text-sm font-medium">{emailSystemFields.find(item => item.id === rule.field)?.name ?? "Dado do contato"}</p>
            <Choice id={`rule-operator-${i}`} label="Comparação" value={rule.operator} disabled={p.readOnly} options={emailOperatorsFor(rule.field).map(id=>({id,name:fieldOperators[id]}))} onChange={operator=>change(i,{...rule,operator:operator as typeof rule.operator,...(operator === "within_days" ? {value:7} : {})})}/>
            {needsValue(rule.operator) && (rule.operator === "within_days" ? <div className="space-y-1"><Label htmlFor={`rule-days-${i}`}>Quantidade de dias</Label><Input id={`rule-days-${i}`} type="number" min={1} max={36500} step={1} disabled={p.readOnly} value={String(rule.value ?? "")} onChange={event=>change(i,{...rule,value:event.target.value ? Number(event.target.value) : ""})}/></div> : systemFieldChoices[rule.field] ? <Choice id={`rule-value-${i}`} label="Valor" value={String(rule.value ?? "")} disabled={p.readOnly} options={systemFieldChoices[rule.field]} onChange={value=>change(i,{...rule,value})}/> : isDateSystemField(rule.field) ? <EmailDateValue id={`rule-value-${i}`} value={rule.value} disabled={p.readOnly} onChange={value=>change(i,{...rule,value})}/> : <FieldValue id={`rule-value-${i}`} field={emailSystemFields.find(item=>item.id===rule.field)} value={rule.value} disabled={p.readOnly} onChange={value=>change(i,{...rule,value})}/>)}
          </> : rule.type === "bot_field" ? <>
            <Choice id={`rule-bot-${i}`} label="Campo do bot" value={rule.field_id} disabled={p.readOnly || p.catalogLoading} options={botFields} onChange={field_id => change(i, { type: "bot_field", field_id, operator: "equals", value: initialFieldValue(botFields.find(f => f.id === field_id)) })} />
            <Choice id={`rule-operator-${i}`} label="Comparação" value={rule.operator} disabled={p.readOnly} options={botOperatorsFor(botFields.find(f => f.id === rule.field_id)?.type).map(id => ({ id, name: fieldOperators[id] }))} onChange={operator => change(i, { ...rule, operator: operator as typeof rule.operator })} />
            {needsValue(rule.operator) ? <FieldValue key={`${i}-${rule.field_id}`} id={`rule-value-${i}`} field={botFields.find(f => f.id === rule.field_id)} value={rule.value} disabled={p.readOnly} onChange={value => change(i, { ...rule, value })} /> : null}
          </> : <>
            <Choice id={`rule-field-${i}`} label="Campo de contato" value={rule.field_id} disabled={p.readOnly || p.catalogLoading} options={fields} onChange={field_id => change(i, { type: "field", field_id, operator: "equals", value: initialFieldValue(fields.find(f => f.id === field_id)) })} />
            <Choice id={`rule-operator-${i}`} label="Comparação" value={rule.operator} disabled={p.readOnly} options={operatorsFor(field).map(id => ({ id, name: fieldOperators[id] }))} onChange={operator => change(i, { ...rule, operator: operator as typeof rule.operator })} />
            {needsValue(rule.operator) ? <FieldValue key={`${i}-${rule.field_id}`} id={`rule-value-${i}`} field={field} value={rule.value} disabled={p.readOnly} onChange={value => change(i, { ...rule, value })} /> : null}
          </>}
          <Button variant="ghost" size="sm" disabled={p.readOnly} onClick={() => set(rules.filter((_, j) => i !== j))}><Trash2 className="size-4" aria-hidden="true" />Remover regra {i + 1}</Button>
        </div></NumberedStep></li>
      })}
    </ol>
    <Button variant="secondary" size="sm" disabled={p.readOnly} onClick={() => set([...rules, { type: "tag", tag_id: "", operator: "has" }])}><Plus className="size-4" aria-hidden="true" />Adicionar regra</Button>
    <NodeLinks p={p} />
  </SidePanel>
}


function EmailDateValue({id,value,disabled,onChange}:{id:string;value:unknown;disabled:boolean;onChange:(value:unknown)=>void}) {
  const date=typeof value === "number" && Number.isFinite(value) ? new Date(value) : null
  const local=date && !Number.isNaN(date.getTime()) ? new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16) : ""
  return <div className="space-y-1"><Label htmlFor={id}>Data e hora</Label><Input id={id} type="datetime-local" value={local} disabled={disabled} onChange={event=>onChange(event.target.value ? new Date(event.target.value).getTime() : "")}/></div>
}

export function RandomizerPanel(p: PanelProps) {
  const variations = getVariations(p.node.data.config)
  const total = variations.reduce((sum, v) => sum + v.weight, 0)
  return <SidePanel title="Dividir caminhos" tone="action" onClose={p.onClose}>
    <NodeErrors errors={p.errors} show={p.showErrors} />
    <Choice id="random-every-time" label="Como escolher o caminho" value={String(p.node.data.config.random_every_time ?? true)} disabled={p.readOnly}
      options={[{ id: "true", name: "Sortear a cada passagem" }, { id: "false", name: "Manter o caminho escolhido para o contato" }]} onChange={v => p.updateConfig({ random_every_time: v === "true" })} />
    <p className="text-xs text-text-muted">A chance de cada caminho é seu peso dividido pela soma dos pesos. Uma saída sem ligação encerra o fluxo.</p>
    {!variations.length ? <p className="text-text-muted">Adicione entre dois e seis caminhos.</p> : null}
    <ol aria-label="Caminhos do sorteio" className="space-y-3">
      {variations.map((v, i) => <li key={v.id} className="space-y-2 rounded-lg border border-border p-3">
        <Label htmlFor={`variation-weight-${i}`}>Peso do caminho {i + 1}</Label>
        <Input id={`variation-weight-${i}`} type="number" step="any" min={0} disabled={p.readOnly} value={Number.isFinite(v.weight) ? v.weight : ""}
          onChange={e => p.updateConfig({ variations: variations.map((x, j) => j === i ? { ...x, weight: Number(e.target.value) } : x) })} />
        <p className="text-xs text-text-muted">{total > 0 && Number.isFinite(total) && v.weight > 0 ? `${(v.weight / total * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}% de chance` : "Defina um peso positivo"}</p>
        <Button variant="ghost" size="sm" disabled={p.readOnly || variations.length <= 2} onClick={() => {
          p.setLink(v.id, null)
          p.updateConfig({ variations: variations.filter((_, j) => j !== i) })
        }}><Trash2 className="size-4" aria-hidden="true" />Remover caminho {i + 1}</Button>
      </li>)}
    </ol>
    <Button variant="secondary" size="sm" disabled={p.readOnly || variations.length >= 6} onClick={() => p.updateConfig({ variations: [...variations, { id: newId("v", [...variations.map(v => v.id), ...p.edges.filter(e => e.source === p.node.id).map(e => e.sourceHandle ?? "")]), weight: 1 }] })}><Plus className="size-4" aria-hidden="true" />Adicionar caminho</Button>
    <NodeLinks p={p} />
  </SidePanel>
}

export function StartAutomationPanel(p: PanelProps) {
  const options = (p.automations ?? []).filter(a => a.id !== p.automationId && a.status === "live" && a.published_version_id && !a.deleted_at)
  return <SidePanel title="Iniciar automação" tone="action" onClose={p.onClose}>
    <NodeErrors errors={p.errors} show={p.showErrors} />
    <CatalogNotice p={p} kind="automations" />
    <Choice id="automation-id" label="Automação de destino" value={String(p.node.data.config.automation_id ?? "")} disabled={p.readOnly || p.catalogLoading} options={options} onChange={automation_id => p.updateConfig({ automation_id })} />
    <p className="text-xs text-text-muted">Somente automações publicadas e ativas neste espaço.</p>
    {p.node.type === "start_automation" ? <>
      <Choice id="wait-for-finish" label="Depois de iniciar" value={p.node.data.config.wait_for_finish === true ? "wait" : "go"} disabled={p.readOnly}
        options={[{ id: "wait", name: "Esperar terminar e voltar" }, { id: "go", name: "Seguir sem esperar" }]} onChange={v => p.updateConfig({ wait_for_finish: v !== "go" })} />
      <p className="text-xs text-text-muted">{p.node.data.config.wait_for_finish !== true
        ? "O fluxo continua no passo seguinte logo que a outra automação começa; as duas andam em paralelo."
        : "O fluxo fica parado até a outra automação terminar, inclusive quando ela espera uma resposta do contato, e só então segue para o passo seguinte. Se a outra falhar, ele segue mesmo assim; se ela for cancelada (o contato saiu ou a automação foi para a lixeira) ou parar pela pausa de segurança, este fluxo também é cancelado ou pausa nesse passo, sem seguir."}</p>
    </> : null}
    <NodeLinks p={p} />
  </SidePanel>
}

function TopicRule({ value, disabled, onChange }: { value: string; disabled?: boolean; onChange: (id: string) => void }) {
  const topics = useAsync(() => isFakeMode() ? Promise.resolve([]) : apiRequest<{ items: { id: string; name: string }[] }>("/notification-topics").then(r => r.items), "rule-topics")
  return <Choice id="rule-topic" label="Tópico" value={value || "any"} disabled={disabled} options={[{ id: "any", name: "Qualquer tópico" }, ...(topics.data ?? []).map(t => ({ id: t.id, name: t.name }))]} onChange={v => onChange(v === "any" ? "" : v)} />
}
