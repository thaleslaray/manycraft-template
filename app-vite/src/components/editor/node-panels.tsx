import { integrationsHidden } from "@/lib/hidden-features"
import * as React from "react"
import { useParams } from "react-router"
import { Bell, Eraser, ListOrdered, Plus, SquarePen, Tag, Trash2, UserRound, Zap } from "lucide-react"
import { AutomationPicker, type PickerAutomation } from "@/components/automations/automation-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { SidePanel } from "@/components/ui/side-panel"
import { getActions, getDuration, unitLabel, type DelayUnit, type EditorAction, actionLabels, initialAction } from "./graph"
import { MoreOptions, NodeErrors, NodeLinks, stepName, type PanelProps } from "./panel-shared"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import { ExternalRequestFields } from "./external-request-panel"
import { Choice, CatalogNotice } from "./logic-panels"
import { FieldOperationControls } from "./field-operation"
import { initialFieldValue, describeDelay } from "./graph"
import { TimeWindowControls, DateSourceControls, OffsetControls, TimezoneControl } from "./temporal-controls"
import { apiRequest, isFakeMode } from "@/data/api"
import { listTemplates, templateOptions } from "@/data/message-templates"
import { listApps } from "@/components/settings/apps-settings"
import { variables as templateVariables } from "../../../../engine/src/channels/template-draft"
import { useAsync } from "@/hooks/use-async"
import { defaultWindow, describeSmartDelay, type TimeWindow, type DateSource, type DateOffset } from "./temporal"

const MAX_ACTIONS = 5
const actionIcons: Record<string, React.ComponentType<{ className?: string }>> = { add_tag: Tag, remove_tag: Tag, set_custom_field_value: SquarePen, unset_custom_field_value: Eraser, add_to_sequence: ListOrdered, remove_from_sequence: ListOrdered, assign_conversation: UserRound, notify_admin: Bell }

export function ActionPanel(p: PanelProps) {
  const acts = getActions(p.node.data.config)
  const fields = p.fields ?? []
  const off = p.readOnly
  const set = (next: EditorAction[]) => p.updateConfig({ actions: next })
  const change = (i: number, action: EditorAction) => set(acts.map((a, j) => j === i ? action : a))
  const name = stepName(p)
  // Uma linha por ação; o formulário abre ao clicar na linha (a ação nova já nasce aberta).
  // A ação não tem id no fluxo salvo; cada linha ganha um id só da tela, que acompanha a ação ao remover e ao editar.
  const [open, setOpen] = React.useState<string | null>(null)
  const ids = React.useRef<string[]>([])
  ids.current.length = Math.min(ids.current.length, acts.length)
  while (ids.current.length < acts.length) ids.current.push(crypto.randomUUID())
  return <SidePanel title={name.title} rename={name.rename} tone="action" onClose={p.onClose} bodyClassName="px-5 py-5">
    <NodeErrors errors={p.errors} show={p.showErrors} />
    <p className="text-sm font-medium">Realize as seguintes ações:</p>
    <CatalogNotice p={p} kind="fields" />
    <CatalogNotice p={p} kind="sequences" />
    <CatalogNotice p={p} kind="members" />
    <CatalogNotice p={p} kind="connections" />
    <ol aria-label="Ações do passo" className="space-y-3">
      {acts.map((a, i) => { const Icon = actionIcons[a.type] ?? Zap, id = ids.current[i], aberta = open === id; return <li key={id} className={aberta ? "rounded-lg border border-border p-3" : ""}>
        <button type="button" aria-expanded={aberta} aria-controls={`act-form-${i}`} aria-label={`Ação ${i + 1}: ${actionLabels[a.type] ?? a.type}`} onClick={() => setOpen(aberta ? null : id)} className="flex w-full items-center gap-3 rounded-md px-1 py-1.5 text-left text-sm hover:bg-surface-muted">
          <Icon className="size-4 shrink-0 text-warning" aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{actionLabels[a.type] ?? a.type}</span>
        </button>
        <div id={`act-form-${i}`} hidden={!aberta} className="mt-3 space-y-3">
        <Choice id={`act-op-${i}`} label={`Ação ${i + 1}`} value={a.type} disabled={off}
          options={Object.entries(actionLabels).filter(([id]) => id !== "google_sheets" || !integrationsHidden || a.type === "google_sheets").map(([id, name]) => ({ id, name }))}
          onChange={type => change(i, initialAction(type as EditorAction["type"], a, fields))} />
        {"tag_id" in a ? <Choice id={`act-tag-${i}`} label="Tag" value={a.tag_id} disabled={off} options={p.tags} onChange={tag_id => change(i, { ...a, tag_id })} /> : null}
        {"sequence_id" in a ? <>
          <Choice id={`act-sequence-${i}`} label="Sequência" value={a.sequence_id} disabled={off || p.catalogLoading || p.catalogErrors?.sequences} options={p.sequences ?? []} onChange={sequence_id => change(i, { ...a, sequence_id })} />
          <p className="text-xs text-text-muted">{a.type === "add_to_sequence" ? "Inscreve a pessoa no primeiro passo. Para reiniciar, cancele a inscrição antes de inscrever novamente." : "Interrompe os próximos passos desta sequência para a pessoa."}</p>
        </> : null}
        {a.type === "change_global_field_value" ? <>
          <Choice id={`act-bot-${i}`} label="Campo do bot" value={a.field_id} disabled={off || p.catalogLoading} options={p.botFields ?? []} onChange={field_id => change(i, { type: a.type, field_id, value: "" })} />
          {p.botFields?.find(f => f.id === a.field_id)?.type === "number" ? <Choice id={`act-bot-op-${i}`} label="Operação" value={a.operation ?? "set"} disabled={off}
            options={[{ id: "set", name: "Definir" }, { id: "add", name: "Somar (contador)" }, { id: "subtract", name: "Subtrair" }]} onChange={operation => change(i, { ...a, operation: operation as "set" | "add" | "subtract" })} /> : null}
          <div className="space-y-1"><Label htmlFor={`act-bot-value-${i}`}>Novo valor (vazio limpa)</Label>
            <Input id={`act-bot-value-${i}`} value={a.value == null ? "" : String(a.value)} disabled={off} onChange={e => { const type = p.botFields?.find(f => f.id === a.field_id)?.type, raw = e.target.value
              change(i, { ...a, value: raw === "" ? null : type === "number" && Number.isFinite(Number(raw)) ? Number(raw) : type === "boolean" && (raw === "true" || raw === "false") ? raw === "true" : raw }) }} /></div>
          <p className="text-xs text-text-muted">O valor vale para todos os contatos. Use {"{{bot:…}}"} nas mensagens para mostrar.</p>
        </> : null}
        {(a.type === "set_custom_field_value" || a.type === "unset_custom_field_value") ? <>
          <Choice id={`act-field-${i}`} label="Campo de contato" value={a.field_id} disabled={off || p.catalogLoading} options={fields} onChange={field_id => change(i, { type: a.type, field_id, ...(a.type === "set_custom_field_value" ? { value: initialFieldValue(fields.find(f => f.id === field_id)) } : {}) })} />
          {a.type === "set_custom_field_value" ? <FieldOperationControls index={i} action={a} field={fields.find(f => f.id === a.field_id)} p={p} change={next => change(i, next)} /> : null}
        </> : null}
        {a.type === "assign_conversation" ? <Choice id={`act-assignee-${i}`} label="Pessoa responsável" value={a.assignee_id ?? "unassigned"} disabled={off || p.catalogLoading || p.catalogErrors?.members}
          options={[{ id: "unassigned", name: "Sem responsável" }, ...(p.members ?? [])]} onChange={value => change(i, { ...a, assignee_id: value === "unassigned" ? null : value })} /> : null}
        {a.type === "notify_admin" ? <>
          <Choice id={`act-recipient-${i}`} label="Quem recebe o aviso" value={a.recipient_id ?? "team"} disabled={off || p.catalogLoading || p.catalogErrors?.members}
            options={[{ id: "team", name: "Toda a equipe" }, ...(p.members ?? [])]} onChange={value => change(i, { ...a, recipient_id: value === "team" ? undefined : value })} />
          <Label htmlFor={`act-notification-${i}`}>Mensagem para a equipe</Label>
          <Input id={`act-notification-${i}`} value={a.message ?? ""} maxLength={2000} disabled={off} onChange={e => change(i, { ...a, message: e.target.value })} />
          <fieldset className="space-y-1" disabled={off}>
            <legend className="text-sm font-medium">Também avisar por</legend>
            {([["email", "E-mail"], ["chat", "Telegram"]] as const).map(([via, name]) => <label key={via} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-accent" checked={a.via?.includes(via) ?? false}
                onChange={e => { const rest = (a.via ?? []).filter(v => v !== via); const next = e.target.checked ? [...rest, via] : rest; change(i, { ...a, via: next.length ? next : undefined }) }} />{name}</label>)}
          </fieldset>
          <p className="text-xs text-text-muted">O aviso sempre fica nas notificações internas da equipe. E-mail e Telegram só chegam a quem cadastrou o contato em Configurações &gt; Notificações. Push não existe aqui (não há app móvel).</p>
        </> : null}
        {a.type === "pause_automations" ? <Choice id={`act-pause-scope-${i}`} label="O que pausar" value={a.automation_id ?? (a.scope ? `scope:${a.scope}` : "all")} disabled={off || p.catalogLoading}
          options={[{ id: "all", name: "Todas as automações do contato" }, { id: "scope:rules", name: "Só as iniciadas por regras" }, { id: "scope:sequences", name: "Só as iniciadas por sequências" }, ...(p.automations ?? []).filter(x => !x.deleted_at).map(x => ({ id: x.id, name: `Só: ${x.name}` }))]}
          onChange={value => change(i, { ...a, automation_id: value === "all" || value.startsWith("scope:") ? undefined : value, scope: value.startsWith("scope:") ? value.slice(6) as "rules" | "sequences" : undefined })} /> : null}
        {a.type === "pause_automations" ? <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><Label htmlFor={`act-pause-${i}`}>Duração da pausa</Label><Input id={`act-pause-${i}`} type="number" min={1} step={1} disabled={off} value={a.duration?.value ?? ""} onChange={e => change(i, { ...a, duration: { unit: a.duration?.unit ?? "minutes", value: Number(e.target.value) } })} /></div>
          <Choice id={`act-unit-${i}`} label="Unidade da pausa" value={a.duration?.unit ?? "minutes"} disabled={off} options={Object.entries(unitLabel).map(([id, name]) => ({ id, name }))} onChange={unit => change(i, { ...a, duration: { value: a.duration?.value ?? 0, unit: unit as DelayUnit } })} />
        </div> : null}
        {a.type === "set_user_level_menu" ? <div className="space-y-2">
          <p className="text-xs text-text-muted">Menu só deste contato (até 20 itens; até 10 trocas a cada 10 minutos). Sem itens, volta ao menu da conexão.</p>
          {a.items.map((it, k) => <div key={k} className="flex gap-2"><Input aria-label={`Título do item ${k + 1}`} maxLength={30} value={it.title} disabled={off} onChange={e => change(i, { ...a, items: a.items.map((x, j) => j === k ? { ...x, title: e.target.value } : x) })} />
            <div className="min-w-0 flex-1"><MenuItemAutomation index={k} value={it.automation_id} disabled={off} automations={(p.automations ?? []).filter(x => !x.deleted_at)} onChange={automation_id => change(i, { ...a, items: a.items.map((x, j) => j === k ? { ...x, automation_id } : x) })} /></div>
            <Button size="icon" variant="ghost" aria-label="Remover item" disabled={off} onClick={() => change(i, { ...a, items: a.items.filter((_, j) => j !== k) })}><Trash2 className="size-4" /></Button></div>)}
          {a.items.length < 20 ? <Button size="sm" variant="secondary" disabled={off} onClick={() => change(i, { ...a, items: [...a.items, { title: "", automation_id: "" }] })}><Plus className="size-4" />Item</Button> : null}
        </div> : null}
        {a.type === "apps_request" ? <AppActionFields index={i} action={a} disabled={off} change={next => change(i, next)} /> : null}
        {"topic_id" in a ? <TopicChoice id={`act-topic-${i}`} value={a.topic_id} disabled={off} onChange={topic_id => change(i, { ...a, topic_id })} /> : null}
        {"connection_id" in a ? <Choice id={`act-connection-${i}`} label="Conexão da inscrição" value={a.connection_id} disabled={off || p.catalogLoading || p.catalogErrors?.connections} options={(p.connections ?? []).map(c => ({ id: c.id, name: c.displayName || c.label }))} onChange={connection_id => change(i, { ...a, connection_id })} /> : null}
        {a.type === "delete_subscriber" ? <p className="rounded-md bg-warning-soft p-3 text-sm text-warning">Exclui os dados deste contato e encerra suas automações. A publicação exige confirmação.</p> : null}
        {a.type === "fire_custom_event" ? <>
          <div className="space-y-1"><Label htmlFor={`act-event-${i}`}>Nome da conversão</Label><Input id={`act-event-${i}`} value={a.event_name ?? ""} maxLength={100} disabled={off} onChange={e => change(i, { ...a, event_name: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor={`act-conversion-${i}`}>Valor da conversão (opcional)</Label><Input id={`act-conversion-${i}`} type="number" min={0} step="any" value={a.value ?? ""} disabled={off} onChange={e => change(i, { ...a, value: e.target.value === "" ? undefined : Number(e.target.value) })} /></div>
          <Choice id={`act-currency-${i}`} label="Moeda" value={a.currency ?? "BRL"} disabled={off} options={[{ id: "BRL", name: "Real (BRL)" }, { id: "USD", name: "Dólar (USD)" }, { id: "EUR", name: "Euro (EUR)" }]} onChange={currency => change(i, { ...a, currency: currency as "BRL" | "USD" | "EUR" })} />
        </> : null}
        {a.type === "google_sheets" ? <SheetsFields index={i} action={a} fields={fields} disabled={off} change={next => change(i, next)} /> : null}
        {a.type === "external_request" ? <ExternalRequestFields index={i} action={a} p={p} change={next => change(i, next)} /> : null}
        <Button variant="ghost" size="sm" disabled={off} onClick={() => { ids.current.splice(i, 1); set(acts.filter((_, j) => j !== i)) }}><Trash2 className="size-4" aria-hidden="true" />Remover ação {i + 1}</Button>
        </div>
      </li> })}
    </ol>
    {!acts.length ? <p className="text-text-muted">Nenhuma ação ainda.</p> : null}
    <button type="button" aria-label="Adicionar ação" disabled={off || acts.length >= MAX_ACTIONS} onClick={() => { const novo = crypto.randomUUID(); ids.current.push(novo); set([...acts, { type: "add_tag", tag_id: "" }]); setOpen(novo) }} className="flex h-11 w-full items-center justify-center gap-1 rounded-md border border-dashed border-warning/60 text-sm font-medium text-warning hover:bg-node-action/40 disabled:cursor-not-allowed disabled:opacity-50"><Plus className="size-4" aria-hidden="true" />Ação</button>
    <NodeLinks p={p} />
  </SidePanel>
}

export function DelayPanel(p: PanelProps) {
  const config = p.node.data.config
  const duration = getDuration(config)
  const mode = config.mode === "date" ? "date" : "duration"
  const off = p.readOnly
  const name = stepName(p)
  const setMode = (mode: string) => p.updateConfig(mode === "date" ? { mode, duration: undefined, date: config.date ?? { kind: "specific", at: "" } } : { mode: "duration", date: undefined, offset: undefined, duration: duration.value ? duration : { value: 1, unit: "minutes" } })
  return <SidePanel title={name.title} rename={name.rename} tone="delay" onClose={p.onClose}>
    <NodeErrors errors={p.errors} show={p.showErrors} />
    <Tabs value={mode} onValueChange={off ? undefined : setMode} className="items-center">
      <TabsList variant="segmented" aria-label="Tipo de espera" className="self-center">
        <TabsTrigger value="duration" disabled={off}>Duração</TabsTrigger>
        <TabsTrigger value="date" disabled={off}>Data</TabsTrigger>
      </TabsList>
    </Tabs>
    <div className="space-y-3">
      {mode === "duration" ? <>
        <p className="text-sm font-medium">Aguardar por</p>
        <div className="flex items-center gap-2">
          <Input id="delay-v" aria-label="Aguardar por" type="number" min={1} step={1} value={duration.value || ""} disabled={off} className="min-w-0 flex-1" onChange={e => p.updateConfig({ duration: { ...duration, value: Number(e.target.value) } })} />
          <div className="w-32 shrink-0"><Choice id="delay-u" label="Unidade" hideLabel value={duration.unit} disabled={off} options={Object.entries(unitLabel).map(([id, name]) => ({ id, name }))} onChange={unit => p.updateConfig({ duration: { ...duration, unit: unit as DelayUnit } })} /></div>
        </div>
        <p className="text-xs text-text-muted">Insira um número. Limite de 365 dias.</p>
      </> : <>
        <CatalogNotice p={p} kind="fields" />
        <DateSourceControls id="delay-date" source={config.date as DateSource ?? { kind: "specific", at: "" }} fields={p.fields ?? []} disabled={off} onChange={date => p.updateConfig({ date })} />
        <OffsetControls id="delay-offset" value={config.offset as DateOffset} disabled={off} onChange={offset => p.updateConfig({ offset })} />
      </>}
    </div>
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <label id="delay-window-rotulo" className="text-sm font-medium">Enviar durante um período determinado</label>
        <Switch aria-labelledby="delay-window-rotulo" checked={!!config.window} disabled={off} onCheckedChange={on => p.updateConfig({ window: on ? defaultWindow : undefined })} />
      </div>
      <p className="text-xs text-text-muted">A mensagem seguinte só sai quando o horário local do contato estiver dentro do período. Se o fuso do contato for desconhecido, vale o fuso da conta.</p>
      {config.window ? <TimeWindowControls id="delay-window" value={config.window as TimeWindow} disabled={off} onChange={window => p.updateConfig({ window })} /> : null}
    </div>
    <NodeLinks p={p} />
    <MoreOptions>
      <TimezoneControl id="delay-timezone" value={config.timezone as string | undefined} disabled={off} contact onChange={timezone => p.updateConfig({ timezone })} />
      <div role="note" className="space-y-2 rounded-lg bg-surface-muted p-3 text-sm"><p className="font-semibold">{describeSmartDelay(config, describeDelay(duration), p.fields)}</p><p className="text-xs text-text-muted">A espera não renova a permissão de envio. Se a janela da conexão vencer, o motivo do bloqueio aparecerá na conversa.</p></div>
    </MoreOptions>
  </SidePanel>
}

export function DynamicPanel(p: PanelProps) {
  const config = p.node.data.config
  const off = p.readOnly
  return <SidePanel title="Bloco dinâmico" tone="action" onClose={p.onClose}>
    <NodeErrors errors={p.errors} show={p.showErrors} />
    <div className="space-y-1"><Label htmlFor="dynamic-url">Endereço do servidor</Label>
      <Input id="dynamic-url" type="url" placeholder="https://" value={String(config.url ?? "")} disabled={off} onChange={e => p.updateConfig({ url: e.target.value })} /></div>
    <Choice id="dynamic-method" label="Método" value={String(config.method ?? "POST")} disabled={off} options={["POST", "GET", "PUT", "PATCH"].map(m => ({ id: m, name: m }))} onChange={method => p.updateConfig({ method })} />
    <div className="space-y-1"><Label htmlFor="dynamic-headers">Cabeçalhos (um por linha, Nome: valor)</Label>
      <Textarea id="dynamic-headers" rows={2} disabled={off} value={((config.headers as { name: string; value: string }[] | undefined) ?? []).map(h => `${h.name}: ${h.value}`).join("\n")}
        onChange={e => p.updateConfig({ headers: e.target.value.split("\n").map(l => l.split(/:(.*)/s)).filter(([n]) => n?.trim()).map(([n, v]) => ({ name: n.trim(), value: (v ?? "").trim() })) })} /></div>
    <div className="space-y-1"><Label htmlFor="dynamic-body">Corpo (opcional; JSON com variáveis)</Label>
      <Textarea id="dynamic-body" rows={3} className="font-mono text-xs" disabled={off} value={String(config.body ?? "")} placeholder='{"contato": {{full_contact_data}}}' onChange={e => p.updateConfig({ body: e.target.value || undefined })} />
      <p className="text-xs text-text-muted">Sem corpo, enviamos os dados completos do contato.</p></div>
    <div className="space-y-1"><Label htmlFor="dynamic-fallback">Texto reserva</Label>
      <Input id="dynamic-fallback" value={String(config.fallback_text ?? "")} disabled={off} onChange={e => p.updateConfig({ fallback_text: e.target.value || undefined })} />
      <p className="text-xs text-text-muted">Enviado quando o servidor não responde em 10 segundos ou devolve algo inválido.</p></div>
    <div role="note" className="space-y-1 rounded-lg bg-surface-muted p-3 text-sm">
      <p>Chamamos o seu servidor com o método escolhido. A resposta no formato v2 traz até 10 mensagens, 5 ações (etiquetas e campos pelo nome) e 11 respostas rápidas.</p>
      <p className="text-xs text-text-muted">Botões do tipo retorno chamam o servidor de novo quando o contato toca.</p>
    </div>
    <NodeLinks p={p} />
  </SidePanel>
}

/** Campos da ação Google Sheets: operação, planilha e aba; inserir pede os valores das colunas, buscar e atualizar pedem a coluna de busca. */
function SheetsFields({ index, action, fields, disabled, change }: { index: number; action: Extract<EditorAction, { type: "google_sheets" }>; fields: { id: string; name: string }[]; disabled: boolean; change: (next: EditorAction) => void }) {
  const s = action.sheets
  const set = (patch: Partial<typeof s>) => change({ ...action, sheets: { ...s, ...patch } })
  const lines = (s.values ?? []).map(v => typeof v === "string" ? v : `${(v as { column: string }).column}=${(v as { value: string }).value}`).join("\n")
  return <div className="space-y-2">
    <Choice id={`gs-op-${index}`} label="Operação" value={s.operation} disabled={disabled} options={[{ id: "insert_row", name: "Inserir linha" }, { id: "get_row", name: "Buscar linha e salvar em campos" }, { id: "update_row", name: "Atualizar linha" }]}
      onChange={operation => change({ ...action, sheets: operation === "insert_row" ? { operation, spreadsheet_id: s.spreadsheet_id, sheet: s.sheet, values: [""] } : operation === "get_row" ? { operation, spreadsheet_id: s.spreadsheet_id, sheet: s.sheet, lookup_column: "A", lookup_value: "", mappings: [] } : { operation: "update_row", spreadsheet_id: s.spreadsheet_id, sheet: s.sheet, lookup_column: "A", lookup_value: "", values: [] } })} />
    <div className="space-y-1"><Label htmlFor={`gs-id-${index}`}>ID da planilha</Label><Input id={`gs-id-${index}`} value={s.spreadsheet_id} disabled={disabled} placeholder="o código entre /d/ e /edit no link" onChange={e => set({ spreadsheet_id: e.target.value.trim() })} /></div>
    <div className="space-y-1"><Label htmlFor={`gs-sheet-${index}`}>Aba</Label><Input id={`gs-sheet-${index}`} value={s.sheet} disabled={disabled} onChange={e => set({ sheet: e.target.value })} /></div>
    {s.operation !== "insert_row" ? <div className="grid grid-cols-[6rem_1fr] gap-2">
      <div className="space-y-1"><Label htmlFor={`gs-col-${index}`}>Coluna</Label><Input id={`gs-col-${index}`} value={s.lookup_column ?? "A"} maxLength={3} disabled={disabled} onChange={e => set({ lookup_column: e.target.value.toUpperCase() })} /></div>
      <div className="space-y-1"><Label htmlFor={`gs-val-${index}`}>Valor procurado</Label><Input id={`gs-val-${index}`} value={s.lookup_value ?? ""} disabled={disabled} placeholder="{{email|}}" onChange={e => set({ lookup_value: e.target.value })} /></div>
    </div> : null}
    {s.operation === "get_row" ? <div className="space-y-1"><Label htmlFor={`gs-map-${index}`}>Coluna para campo (uma por linha: B=ID do campo)</Label>
      <Textarea id={`gs-map-${index}`} rows={3} disabled={disabled} value={(s.mappings ?? []).map(m => `${m.column}=${m.field_id}`).join("\n")} onChange={e => set({ mappings: e.target.value.split("\n").map(l => l.split("=")).filter(([c, f]) => c?.trim() && f?.trim()).map(([c, f]) => ({ column: c.trim().toUpperCase(), field_id: f.trim() })) })} />
      <p className="text-xs text-text-muted">Campos: {fields.map(f => `${f.name} (${f.id})`).join(", ") || "nenhum"}</p></div>
      : <div className="space-y-1"><Label htmlFor={`gs-values-${index}`}>{s.operation === "insert_row" ? "Valores das colunas, um por linha (aceita {{variáveis}})" : "Células a mudar, uma por linha: B=valor"}</Label>
        <Textarea id={`gs-values-${index}`} rows={4} disabled={disabled} value={lines} onChange={e => set({ values: s.operation === "insert_row" ? e.target.value.split("\n") : e.target.value.split("\n").map(l => l.split("=")).filter(([c]) => c?.trim()).map(([c, ...v]) => ({ column: c.trim().toUpperCase(), value: v.join("=") })) })} /></div>}
    <p className="text-xs text-text-muted">Conecte a conta em Configurações &gt; Integrações e compartilhe a planilha com o e-mail dela. Erros aparecem em Configurações &gt; Registros.</p>
  </div>
}

/** Tópicos de notificação do espaço (Configurações › Tópicos de notificação). */
function TopicChoice({ id, value, disabled, onChange }: { id: string; value: string; disabled?: boolean; onChange: (id: string) => void }) {
  const topics = useAsync(() => isFakeMode() ? Promise.resolve([]) : apiRequest<{ items: { id: string; name: string; channel_name: string }[] }>("/notification-topics").then(r => r.items), "editor-topics")
  return <Choice id={id} label="Tópico" value={value} disabled={disabled || topics.loading} options={(topics.data ?? []).map(t => ({ id: t.id, name: `${t.name} · ${t.channel_name}` }))} onChange={onChange} />
}

/** Modelo aprovado: o envio aceito fora da janela de conversa (ex.: WhatsApp depois de 24 h). Os parâmetros aceitam variáveis do contato. */
export function TemplateMessagePanel(p: PanelProps) {
  const config = p.node.data.config as { connection_id?: string; template_id?: string; params?: Record<string, string> }
  const off = p.readOnly
  const options = useAsync(() => isFakeMode() ? Promise.resolve({ canEdit: false, connections: [] }) : templateOptions(), "tpl-node-options")
  const connection = config.connection_id ?? options.data?.connections[0]?.id ?? ""
  const list = useAsync(() => connection && !isFakeMode() ? listTemplates(connection) : Promise.resolve([]), `tpl-node|${connection}`)
  const approved = (list.data ?? []).filter(t => t.status === "approved")
  const chosen = approved.find(t => t.id === config.template_id)
  const names = chosen ? templateVariables(chosen.body) : []
  return <SidePanel title="Modelo (fora da janela)" tone="message" onClose={p.onClose}>
    <NodeErrors errors={p.errors} show={p.showErrors} />
    <p className="text-sm text-text-muted">Envia um modelo aprovado. É o único envio aceito quando a janela de 24 h do WhatsApp já fechou.</p>
    <Choice id="tpl-connection" label="Conexão" value={connection} disabled={off} options={(options.data?.connections ?? []).map(c => ({ id: c.id, name: c.label }))} onChange={connection_id => p.updateConfig({ connection_id, template_id: "", params: {} })} />
    <Choice id="tpl-template" label="Modelo aprovado" value={config.template_id ?? ""} disabled={off || list.loading} options={approved.map(t => ({ id: t.id, name: t.name }))} onChange={template_id => p.updateConfig({ template_id, params: {} })} />
    {chosen ? <p className="whitespace-pre-wrap rounded-md bg-surface-muted p-2 text-sm">{chosen.body}</p> : null}
    {names.map(n => <div key={n} className="space-y-1"><Label htmlFor={`tpl-param-${n}`}>{`{{${n}}}`}</Label>
      <Input id={`tpl-param-${n}`} value={config.params?.[n] ?? ""} disabled={off} placeholder="texto ou {{primeiro_nome}}" onChange={e => p.updateConfig({ params: { ...(config.params ?? {}), [n]: e.target.value } })} /></div>)}
    <NodeLinks p={p} />
  </SidePanel>
}

/** Ação de app instalado: escolhe app e ação e preenche o formulário dela (texto, número ou lista vinda do app). */
function AppActionFields({ index, action, disabled, change }: { index: number; action: Extract<EditorAction, { type: "apps_request" }>; disabled?: boolean; change: (next: EditorAction) => void }) {
  const apps = useAsync(listApps, "editor-apps")
  const app = apps.data?.find(x => x.id === action.app_id)
  const spec = app?.actions.find(x => x.name === action.action)
  return <div className="space-y-2">
    <Choice id={`app-${index}`} label="App" value={action.app_id} disabled={disabled || apps.loading} options={(apps.data ?? []).map(x => ({ id: x.id, name: x.name }))} onChange={app_id => change({ ...action, app_id, action: "", inputs: {} })} />
    {app ? <Choice id={`app-action-${index}`} label="Ação" value={action.action} disabled={disabled} options={app.actions.map(x => ({ id: x.name, name: x.label }))} onChange={name => change({ ...action, action: name, inputs: {} })} /> : null}
    {spec?.form.map(f => f.type === "select" && f.source
      ? <AppSourceChoice key={f.name} id={`app-in-${index}-${f.name}`} appId={action.app_id} source={f.source} label={f.label} value={action.inputs[f.name] ?? ""} disabled={disabled} onChange={v => change({ ...action, inputs: { ...action.inputs, [f.name]: v } })} />
      : <div key={f.name} className="space-y-1"><Label htmlFor={`app-in-${index}-${f.name}`}>{f.label}</Label><Input id={`app-in-${index}-${f.name}`} inputMode={f.type === "number" ? "decimal" : undefined} value={action.inputs[f.name] ?? ""} disabled={disabled} onChange={e => change({ ...action, inputs: { ...action.inputs, [f.name]: e.target.value } })} /></div>)}
  </div>
}
function AppSourceChoice({ id, appId, source, label, value, disabled, onChange }: { id: string; appId: string; source: string; label: string; value: string; disabled?: boolean; onChange: (v: string) => void }) {
  const items = useAsync(() => apiRequest<{ items: { key: string; value: string }[] }>(`/apps/${appId}/sources/${source}`).then(r => r.items), `app-src|${appId}|${source}`)
  return <Choice id={id} label={label} value={value} disabled={disabled || items.loading} options={(items.data ?? []).map(x => ({ id: x.key, name: x.value }))} onChange={onChange} />
}


/** Automação de um item do menu do contato: nome com X, ou "Escolher existente" com prévia. */
function MenuItemAutomation({ index, value, disabled, automations, onChange }: { index: number; value: string; disabled?: boolean; automations: PickerAutomation[]; onChange: (id: string) => void }) {
  const { workspace = "demo" } = useParams()
  return <AutomationPicker workspace={workspace} automations={automations} value={value} disabled={disabled} onChange={onChange} onlyPublished={false} clearLabel={`Remover automação do item ${index + 1}`} buttonAriaLabel={`Automação do item ${index + 1}`} />
}
