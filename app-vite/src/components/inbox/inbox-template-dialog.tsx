import * as React from "react"
import { FileText, Send } from "lucide-react"
import { listTemplates, variables, type MessageTemplate } from "@/data/message-templates"
import { useAsync } from "@/hooks/use-async"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Input, field } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export function InboxTemplateDialog({ connectionId, busy, onClose, onSend, title = "Enviar modelo aprovado", description = "Escolha um modelo e preencha os dados para continuar esta conversa.", fields, blocked = false, emptyHelp }: {
  connectionId: string; busy: boolean; onClose: () => void
  /** Another use of the same dialog (a new conversation) adds its own fields above the template and can hold the send back. */
  title?: string; description?: string; fields?: React.ReactNode; blocked?: boolean; emptyHelp?: React.ReactNode
  onSend: (template: { id: string; params: Record<string, string> }) => Promise<void>
}) {
  const result = useAsync(() => listTemplates(connectionId), connectionId)
  const [selected, setSelected] = React.useState("")
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [error, setError] = React.useState<string | null>(null)
  const approved = result.data?.filter(row => row.status === "approved" && !row.unavailableReason) ?? []
  const model = approved.find(row => row.id === selected)
  const inputs = model ? templateInputs(model) : []
  const ready = !!model && !blocked && inputs.every(input => values[input.key]?.trim())
  const preview = (text: string, prefix = "") => text.replace(/\{\{([a-z][a-z_]*|[1-9]\d*)\}\}/g, (match, key: string) => values[`${prefix}${key}`]?.trim() || match)
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
    <DialogHeader><DialogTitle className="flex items-center gap-2"><FileText className="size-5 shrink-0" aria-hidden="true" />{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
    {result.error ? <Banner variant="danger"><p>Não foi possível carregar os modelos.</p><Button type="button" size="sm" variant="secondary" onClick={result.reload}>Tentar de novo</Button></Banner> : !result.data ? <p role="status">Carregando modelos…</p> : !approved.length ? <><Banner>{emptyHelp ?? "Nenhum modelo aprovado disponível para esta conversa. Atualize os modelos nas configurações ou aguarde uma nova mensagem do contato."}</Banner>{fields}</> : <form className="space-y-4" onSubmit={async event => {
      event.preventDefault()
      event.stopPropagation()
      if (!ready || busy) return
      setError(null)
      try { await onSend({ id: selected, params: Object.fromEntries(inputs.map(input => [input.key, values[input.key].trim()])) }); onClose() }
      catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível enviar o modelo.") }
    }}>
      {fields}
      <div className="space-y-1"><Label htmlFor="inbox-approved-template">Modelo aprovado</Label><select id="inbox-approved-template" className={`${field} h-10`} value={selected} disabled={busy} onChange={event => { setSelected(event.target.value); setValues({}); setError(null) }}><option value="">Escolha um modelo</option>{approved.map(row => <option key={row.id} value={row.id}>{row.name} · {row.language}</option>)}</select></div>
      {inputs.map(input => <div key={input.key} className="space-y-1"><Label htmlFor={`template-value-${input.key}`}>{input.label}</Label><Input id={`template-value-${input.key}`} value={values[input.key] ?? ""} placeholder={input.example} maxLength={1024} required disabled={busy} onChange={event => setValues(previous => ({ ...previous, [input.key]: event.target.value }))} /></div>)}
      {model && <section aria-label="Prévia do modelo" className="space-y-2 rounded-lg border border-border bg-surface-muted p-4 text-sm wrap-anywhere"><h3 className="text-xs font-semibold text-text-muted">Prévia da mensagem</h3>{model.header.type === "text" ? <p className="font-semibold">{preview(model.header.text ?? "", "header:")}</p> : model.header.type !== "none" ? <p className="text-xs text-text-muted">Anexo do modelo: {model.header.type === "image" ? "imagem" : model.header.type === "video" ? "vídeo" : "documento"}</p> : null}<p className="whitespace-pre-wrap">{preview(model.body)}</p>{model.footer && <p className="text-xs text-text-muted">{model.footer}</p>}{model.buttons.map((button, index) => <div key={index} className="rounded-md border border-border bg-surface p-2 text-center text-xs">{button.text}{button.url && <p className="mt-1 text-text-muted">{preview(button.url, `button:${index}:`)}</p>}</div>)}</section>}
      {error && <Banner variant="danger">{error}</Banner>}
      <DialogFooter><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" loading={busy} disabled={!ready}><Send className="size-4" aria-hidden="true" />Enviar modelo</Button></DialogFooter>
    </form>}
  </DialogContent></Dialog>
}
function templateInputs(model: MessageTemplate) {
  return [
    ...variables(model.body).map(key => ({ key, label: `Variável ${key}`, example: model.examples[key] })),
    ...variables(model.header.type === "text" ? model.header.text ?? "" : "").map(key => ({ key: `header:${key}`, label: `Cabeçalho: variável ${key}`, example: model.header.example })),
    ...model.buttons.flatMap((button, index) => variables(button.url ?? "").map(key => ({ key: `button:${index}:${key}`, label: `Botão ${button.text}: variável ${key}`, example: "Valor no final do link" }))),
  ]
}
