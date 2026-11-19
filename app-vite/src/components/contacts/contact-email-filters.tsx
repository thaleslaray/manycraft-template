import * as React from "react"
import { BookmarkPlus, Mail } from "lucide-react"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import type { ContactFilter, EmailFilter } from "@/data/types"
import { useAsync } from "@/hooks/use-async"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export type EmailContactFilters = Pick<ContactFilter, "email_filter" | "contact_filter" | "segment_id">
type FilterRule = { type: "email"; filter: string } | { type: "system_field"; field: string; operator: "gte" | "within_days"; value: number }
type SegmentFilter = { match: "all" | "any"; rules: FilterRule[] }
type Segment = { id: string; name: string; filter: SegmentFilter }
/** Um rótulo por filtro que o motor aceita: filtro novo no motor sem rótulo aqui não compila. */
const emailLabels: Record<EmailFilter, string> = { defined: "E-mail definido", undefined: "E-mail não definido", subscribed: "Marketing por e-mail autorizado", unsubscribed: "Marketing por e-mail desativado", opened: "Abriu um e-mail", clicked: "Clicou em um e-mail", opened_clicked: "Abriu e clicou", opened_not_clicked: "Abriu e não clicou", not_opened: "Ainda não abriu" }
const isEmailFilter = (value: string): value is EmailFilter => Object.hasOwn(emailLabels, value)

export function useEmailSegments() {
  return useAsync(() => isFakeMode() ? Promise.resolve([] as Segment[]) : apiRequest<Segment[]>("/email/segments"), "email-segments")
}

const metricLabels: Record<string, string> = { email_opens: "Aberturas: no mínimo", email_clicks: "Cliques: no mínimo", email_last_opened_at: "Última abertura: últimos dias", email_last_clicked_at: "Último clique: últimos dias" }

/** Uma etiqueta por condição de e-mail ativa, para a faixa de filtros acima da tabela. */
export function emailFilterChips(value: EmailContactFilters, segmentName?: string): { key: string; label: string; clear: EmailContactFilters }[] {
  if (value.segment_id) return [{ key: "segment", label: `Segmento de e-mail: ${segmentName ?? "indisponível"}`, clear: {} }]
  const chips: { key: string; label: string; clear: EmailContactFilters }[] = []
  if (value.email_filter) chips.push({ key: "email", label: emailLabels[value.email_filter], clear: { contact_filter: value.contact_filter } })
  if (value.contact_filter) {
    try {
      const rule = (JSON.parse(value.contact_filter) as SegmentFilter).rules[0]
      if (rule?.type === "system_field") chips.push({ key: "metric", label: `${metricLabels[rule.field] ?? rule.field} ${rule.value}`, clear: { email_filter: value.email_filter } })
    } catch { /* condição ilegível: sem etiqueta */ }
  }
  return chips
}

export function ContactEmailFilters({ value, onChange }: { value: EmailContactFilters; onChange: (value: EmailContactFilters) => void }) {
  const segments = useEmailSegments()
  const [metric, setMetric] = React.useState("none")
  const [amount, setAmount] = React.useState("1")
  const [saving, setSaving] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [error, setError] = React.useState("")
  function metricRules(field: string, raw: string): FilterRule[] {
    if (field === "none" || !raw || !Number.isFinite(Number(raw))) return []
    const count = field.endsWith("_at") ? Math.min(36500, Math.max(1, Math.floor(Number(raw)))) : Math.max(0, Number(raw))
    return [{ type: "system_field", field, operator: field.endsWith("_at") ? "within_days" : "gte", value: count }]
  }
  function setFilter(email: EmailFilter | undefined, field = value.contact_filter ? metric : "none", raw = amount) {
    const rules = metricRules(field, raw)
    onChange({ email_filter: email, ...(rules.length ? { contact_filter: JSON.stringify({ match: "all", rules }) } : {}) })
  }
  const filterRules: FilterRule[] = [...(value.email_filter ? [{ type: "email" as const, filter: value.email_filter }] : []), ...(value.contact_filter ? metricRules(metric, amount) : [])]
  async function save(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError("")
    try {
      const segment = await apiRequest<Segment>("/email/segments", { method: "POST", body: JSON.stringify({ name, filter: { match: "all", rules: filterRules } }) })
      segments.reload()
      setMetric("none")
      onChange({ segment_id: segment.id })
      setOpen(false)
      toast.success("Segmento salvo.")
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar o segmento.") }
    finally { setSaving(false) }
  }
  return <div className="space-y-3 border-t border-border pt-4">
    <div className="flex flex-wrap items-center gap-3"><h3 className="flex items-center gap-2 text-sm font-semibold"><Mail className="size-4" aria-hidden="true" />Filtros de e-mail</h3><p className="text-xs text-text-muted">Atividade e consentimento atualizados pelo motor.</p></div>
    <div className="grid gap-2 sm:grid-cols-2">
      <Select value={value.email_filter ?? "all"} onValueChange={email => setFilter(isEmailFilter(email) ? email : undefined)}><SelectTrigger aria-label="Filtrar por atividade de e-mail" className="whitespace-nowrap"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Qualquer atividade de e-mail</SelectItem>{Object.entries(emailLabels).map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent></Select>
      <Select value={value.segment_id ?? "all"} onValueChange={id => { setMetric("none"); onChange(id === "all" ? {} : { segment_id: id }) }}><SelectTrigger aria-label="Filtrar por segmento"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todos os segmentos</SelectItem>{(segments.data ?? segments.stale ?? []).map(segment => <SelectItem key={segment.id} value={segment.id}>{segment.name}</SelectItem>)}</SelectContent></Select>
      <Select value={value.contact_filter ? metric : "none"} onValueChange={field => { setMetric(field); setFilter(value.email_filter, field) }}><SelectTrigger aria-label="Filtrar por campo de e-mail"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Sem condição adicional</SelectItem><SelectItem value="email_opens">Total de aberturas: no mínimo</SelectItem><SelectItem value="email_clicks">Total de cliques: no mínimo</SelectItem><SelectItem value="email_last_opened_at">Última abertura: nos últimos dias</SelectItem><SelectItem value="email_last_clicked_at">Último clique: nos últimos dias</SelectItem></SelectContent></Select>
    </div>
    {metric !== "none" && value.contact_filter ? <div className="flex flex-wrap items-center gap-2"><Label htmlFor="email-filter-amount">{metric.endsWith("_at") ? "Quantidade de dias" : "Quantidade mínima"}</Label><Input id="email-filter-amount" type="number" min={metric.endsWith("_at") ? "1" : "0"} max={metric.endsWith("_at") ? 36500 : undefined} className="w-28" value={amount} onChange={event => { setAmount(event.target.value); setFilter(value.email_filter, metric, event.target.value) }} /></div> : null}
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-text-muted">{value.segment_id ? "Segmento salvo selecionado." : "Todas as condições acima devem corresponder."}</p><Button size="sm" variant="secondary" disabled={!filterRules.length || isFakeMode()} onClick={() => { setName(""); setOpen(true); setError("") }}><BookmarkPlus className="size-4" aria-hidden="true" />Salvar como segmento</Button></div>
    {segments.error ? <p role="alert" className="text-xs text-danger">Não foi possível carregar os segmentos.<Button size="sm" variant="link" onClick={segments.reload}>Tentar novamente</Button></p> : null}
    {open ? <Dialog open onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Salvar segmento de e-mail</DialogTitle><DialogDescription>O segmento acompanha a atividade dos contatos. Pode ser reutilizado em condições e transmissões.</DialogDescription></DialogHeader><form onSubmit={save} className="space-y-4"><div className="space-y-2"><Label htmlFor="email-segment-name">Nome do segmento</Label><Input id="email-segment-name" required maxLength={120} autoFocus value={name} onChange={event => setName(event.target.value)} /></div>{error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}<div className="flex justify-end gap-2"><Button type="button" variant="secondary" disabled={saving} onClick={() => setOpen(false)}>Cancelar</Button><Button type="submit" loading={saving} disabled={!name.trim()}>Salvar segmento</Button></div></form></DialogContent></Dialog> : null}
  </div>
}
