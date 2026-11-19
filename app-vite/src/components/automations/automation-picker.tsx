import * as React from "react"
import { Link } from "react-router"
import { ArrowRight, GitBranch, X } from "lucide-react"
import { getAutomation } from "@/data"
import { useAsync } from "@/hooks/use-async"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { ChooseExisting } from "@/components/ui/choose-existing"
import { Skeleton } from "@/components/ui/skeleton"

/** Textos enviados pela versão publicada, para a prévia do pop-up e da janela. */
export function publishedTexts(graph: { nodes: { type: string; config: Record<string, unknown> }[] } | undefined): string[] {
  return graph?.nodes.filter(node => ["message", "telegram", "content", "default"].includes(node.type)).flatMap(node => {
    const blocks = node.config.blocks
    return Array.isArray(blocks) ? blocks.flatMap((block: Record<string, unknown>) => (block.kind === "text" || block.type === "text") && typeof block.text === "string" ? [block.text] : []) : []
  }) ?? []
}

export function AutomationPreview({ workspace, id }: { workspace: string; id: string }) {
  const preview = useAsync(() => getAutomation(workspace, id), `${workspace}:${id}`)
  if (preview.loading && !preview.data) return <Skeleton className="h-16 w-full" />
  if (preview.error) return <Banner variant="danger">Não foi possível carregar a prévia. <button className="underline" onClick={preview.reload}>Tentar novamente</button></Banner>
  const published = preview.data?.published_version
  if (!published) return <p className="text-sm text-text-muted">Esta automação ainda não foi publicada. Abra o editor, publique e volte para ativá-la.</p>
  const messages = publishedTexts(published.graph)
  if (!messages.length) return <p className="text-sm text-text-muted">O fluxo publicado não contém uma mensagem de texto para exibir nesta prévia.</p>
  return <div className="space-y-2">{messages.map((message, index) => <p key={index} className="whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 text-sm">{message}</p>)}</div>
}

/** O mínimo que o seletor precisa de cada automação (uma linha da lista ou um item de sequência). */
export type PickerAutomation = { id: string; name: string; published_version_id?: string | null; status?: string }

/**
 * Automação ligada a um item: nome com X para trocar, ou o botão "Escolher existente" que abre o pop-up com prévia.
 * `onlyPublished` esconde rascunhos da lista (o item atual sempre aparece).
 */
export function AutomationPicker({ workspace, automations, value, valueName, onChange, onlyPublished = true, clearLabel, buttonAriaLabel, existingLabel = "Escolher existente", disabled, loadError, reload }: {
  workspace: string
  automations: PickerAutomation[] | undefined
  value: string
  valueName?: string
  onChange: (id: string) => void
  onlyPublished?: boolean
  clearLabel: string
  buttonAriaLabel?: string
  existingLabel?: string
  disabled?: boolean
  loadError?: boolean
  reload?: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const current = automations?.find(item => item.id === value)
  const name = current?.name ?? valueName
  const items = (automations ?? [])
    .filter(item => !onlyPublished || item.published_version_id || item.id === value)
    .map(item => ({ id: item.id, label: item.name, hint: item.status === "stopped" ? "Pausada" : item.published_version_id ? undefined : "Rascunho" }))
  return <div className="min-w-0 space-y-2">
    {value && !buttonAriaLabel ? <div className="flex min-w-0 items-center gap-2">
      <Link to={`/${workspace}/automations/${value}`} className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-bg px-3 py-2 text-sm font-semibold hover:underline"><GitBranch className="size-4 shrink-0 text-text-muted" aria-hidden="true" /><span className="truncate">{name ?? "Automação"}</span><ArrowRight className="size-4 shrink-0 text-text-muted" aria-hidden="true" /></Link>
      <Button type="button" variant="ghost" size="icon" aria-label={clearLabel} disabled={disabled || !automations} onClick={() => onChange("")}><X className="size-4" aria-hidden="true" /></Button>
    </div> : null}
    {buttonAriaLabel ? <div className="flex min-w-0 items-center gap-1">
      <Button type="button" variant="secondary" className="min-w-0 flex-1 justify-start" aria-label={buttonAriaLabel} disabled={disabled || !automations} onClick={() => setOpen(true)}><GitBranch className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">{name ?? "Escolher automação"}</span></Button>
      {value ? <Button type="button" variant="ghost" size="icon" aria-label={clearLabel} disabled={disabled || !automations} onClick={() => onChange("")}><X className="size-4" aria-hidden="true" /></Button> : null}
    </div> : !value ? <Button type="button" variant="secondary" disabled={disabled || !automations} onClick={() => setOpen(true)}>{existingLabel}</Button> : null}
    {loadError ? <Banner variant="danger">Não foi possível carregar as automações. {reload ? <button className="underline" onClick={reload}>Tentar novamente</button> : null}</Banner> : null}
    <ChooseExisting open={open} onOpenChange={setOpen} title="Escolher automação existente" searchLabel="Buscar automação" chooseLabel="Escolher" emptyText="Nenhuma automação publicada." items={items}
      renderPreview={item => <AutomationPreview workspace={workspace} id={item.id} />} onChoose={item => onChange(item.id)} />
  </div>
}
