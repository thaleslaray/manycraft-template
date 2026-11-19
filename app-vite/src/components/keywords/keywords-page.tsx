import { useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { AlertTriangle, GripVertical, Plus, Trash2 } from "lucide-react"
import { findKeywordConflicts, shadowingRule, shadowMessage, type KeywordConflict } from "@/data/keyword-conflicts"
import { KeywordConflictNotice } from "./keyword-conflict-notice"
import { createKeywordAutomation, listConnections, listAutomations, listKeywords, saveKeyword, setKeywordActive, moveKeyword, deleteKeyword, reservedKeywordWords, keywordConditions, keywordChannels, type Keyword, type KeywordInput } from "@/data"
import { useAsync } from "@/hooks/use-async"
import { cn } from "@/lib/utils"
import { RowMenu, RowMenuItem } from "@/components/ui/row-menu"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { Banner } from "@/components/ui/banner"
import { EmptyState } from "@/components/ui/empty-state"
import { SidePanel } from "@/components/ui/side-panel"
import { KeywordChips } from "@/components/ui/keyword-chips"
import { withPending } from "@/components/ui/keyword-merge"
import { PanelFooterBar } from "@/components/ui/panel-footer-bar"
import { TagChip } from "@/components/ui/tag-chip"
import { conditionPhrase } from "./keyword-phrase"
import { KeywordAutomationPreview } from "./keyword-automation-preview"
import { KeywordGroupFields, groupModes } from "./keyword-group-fields"
import { FieldSelect } from "@/components/ui/field-select"
import { AutomationPicker } from "@/components/automations/automation-picker"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"

const rowGrid = "md:grid-cols-[1.75rem_1.5rem_minmax(0,1fr)_minmax(0,1.2fr)_9rem_2rem]"
const channels: Record<string, string> = { instagram: "Instagram", messenger: "Messenger", whatsapp: "WhatsApp", telegram: "Telegram", }
const newKeyword = (): KeywordInput => ({ name: "", channel: "instagram", active: true, automation_id: "", rules: [{ condition: "contains", words: [] }], audience: "direct" })

export function KeywordsPage() {
  const { workspace = "demo" } = useParams()
  const navigate = useNavigate()
  const data = useAsync(async () => {
    const [rows, automations, connections] = await Promise.all([listKeywords(workspace), listAutomations(workspace), listConnections(workspace)])
    return { rows, automations, connections }
  }, workspace, { cache: `keywords|${workspace}` })
  const [editing, setEditing] = useState<{ id?: string; input: KeywordInput } | null>(null)
  const [pending, setPending] = useState(false)
  const [deleting, setDeleting] = useState<Keyword | null>(null)
  const retry = useRef<{ action: () => Promise<unknown>; message: string } | null>(null)
  const [error, setError] = useState("")
  const [errorLink, setErrorLink] = useState<{ to: string; label: string } | null>(null)
  const [notice, setNotice] = useState("")
  const dragId = useRef<string | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const list = data.data ?? data.stale
  const [formError, setFormError] = useState("")
  const [creatingResponse, setCreatingResponse] = useState(false)
  function open(row?: Keyword) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setFormError("")
    setCreatingResponse(false)
    setPendingWords({})
    setEditing(row ? { id: row.id, input: structuredClone(row) } : { input: newKeyword() })
  }
  async function mutate(action: () => Promise<unknown>, message: string) {
    setPending(true)
    setError(""); setErrorLink(null)
    try { await action(); retry.current = null; setNotice(message); data.reload(); return true }
    catch (e) { retry.current = { action, message }; setError(e instanceof Error ? e.message : "A alteração não foi salva."); return false }
    finally { setPending(false) }
  }
  /** Ativar com a automação em rascunho: diz qual automação publicar e leva até ela, sem oferecer "Tentar de novo" (não resolve). */
  function toggleActive(row: Keyword, active: boolean) {
    const automation = list?.automations.find((a) => a.id === row.automation_id)
    if (active && automation && !automation.published_version_id) {
      retry.current = null
      setError(`Publique a automação “${automation.name}” antes de ativar esta palavra-chave.`)
      setErrorLink({ to: `/${workspace}/automations/${automation.id}`, label: "Abrir a automação" })
      return
    }
    void mutate(() => setKeywordActive(workspace, row.id, active), active ? "Palavra-chave ativada." : "Palavra-chave desativada.")
  }
  async function reorder(id: string, index: number) {
    await mutate(() => moveKeyword(workspace, id, index), `Prioridade alterada para a posição ${index + 1}.`)
  }
  const input = editing?.input
  const [pendingWords, setPendingWords] = useState<Record<number, string>>({})
  /** O que vai ser salvo: palavras de cada condição mais o texto ainda sem Enter. */
  const saveInput = input && { ...input, rules: input.rules.map((r, n) => r.condition === "thumbs_up" ? r : { ...r, words: withPending(r.words, pendingWords[n] ?? "") }) }
  function update(patch: Partial<KeywordInput>) {
    setEditing((old) => old ? { ...old, input: { ...old.input, ...patch } } : old)
  }
  async function createResponse() {
    if (!editing) return
    setPending(true); setFormError(""); setCreatingResponse(true)
    try {
      const { automation_id: _automation, active: _active, ...rule } = saveInput!
      const saved = await createKeywordAutomation(workspace, { ...rule, connection_id: effectiveConnection }, editing.id)
      setEditing(null)
      navigate(`/${workspace}/automations/${saved.automation_id}`)
    } catch (e) { setFormError(e instanceof Error ? e.message : "Não foi possível criar a resposta.") }
    finally { setPending(false) }
  }
  const eligibleConnections = list?.connections.filter(c => c.kind === input?.channel && c.profile?.inbound?.message) ?? []
  const effectiveConnection = input?.audience === "group" ? input.connection_id ?? "" : input?.connection_id || eligibleConnections[0]?.id || ""
  const publishedResponse = list?.automations.some(a => a.id === input?.automation_id && a.published_version_id)
  /** Outras regras ativas da mesma conexão que também pegam as palavras desta (regra nova entra no fim da lista). */
  const conflicts = list && saveInput ? findKeywordConflicts({ ...saveInput, id: editing?.id ?? "__nova__", connection_id: effectiveConnection || null }, list.rows) : []
  async function pauseOther(c: KeywordConflict) {
    await mutate(() => setKeywordActive(workspace, c.other.id, false), `Regra “${c.other.name}” pausada.`)
  }
  async function raiseThis() {
    if (editing?.id) await mutate(() => moveKeyword(workspace, editing.id!, 0), "Esta regra subiu para o topo.")
  }
  const canCreateResponse = !!effectiveConnection && !!saveInput?.name.trim() && (saveInput.rules.length > 0 || saveInput.group_match === "mention")
    && saveInput.rules.every(r => r.condition === "thumbs_up" || r.words.length > 0) && saveInput.rules.length <= 2
  return (
    <div className="min-w-0 space-y-6">
      <title>Palavras-chave</title>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">Palavras-chave</h2>
        <Button onClick={() => open()} disabled={pending}><Plus className="size-4" aria-hidden="true" />Criar palavra-chave</Button>
      </header>
      <p className="text-sm text-text-muted">Quando mais de uma regra combina com a mensagem, responde a que está mais acima na lista. Arraste pela alça ou use Subir e Descer no menu para mudar a ordem.</p>
      <p role="status" className="sr-only">{notice}</p>
      {error && <Banner variant="danger">{error} {errorLink ? <Link to={errorLink.to} className="font-semibold underline">{errorLink.label}</Link> : retry.current ? <Button variant="secondary" size="sm" onClick={() => { const last = retry.current; if (last) void mutate(last.action, last.message) }}>Tentar de novo</Button> : null}</Banner>}
      {data.error ? <Banner variant="danger">Não foi possível carregar as regras. <Button size="sm" variant="secondary" onClick={data.reload}>Tentar de novo</Button></Banner>
        : !list ? <div aria-label="Carregando regras" aria-busy="true" className="space-y-3">{[1, 2, 3].map((n) => <Skeleton key={n} className="h-12 w-full" />)}</div>
        : !list.rows.length ? <EmptyState title="Defina a primeira resposta" description="Escolha palavras que as pessoas costumam enviar." action={<Button onClick={() => open()}>Criar palavra-chave</Button>} />
        : <div className="space-y-3">
          <div aria-hidden="true" className={cn("hidden px-4 text-xs text-text-muted md:grid md:items-center md:gap-x-3", rowGrid)}><span /><span>#</span><span>Nome</span><span>Canal e automação</span><span>Estado</span><span /></div>
          <ol aria-label="Regras por prioridade" className="space-y-3">{list.rows.map((row, index) => <li key={row.id}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const id = dragId.current; dragId.current = null; if (id && !pending) void reorder(id, index) }}
          className="rounded-lg bg-surface px-4 py-2 shadow-card">
          <div className={cn("grid min-h-8 min-w-0 grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1", rowGrid)}>
            <button type="button" draggable disabled={pending} aria-label={`Arrastar regra ${row.name}`} title="Arrastar para mudar a prioridade"
              onDragStart={(e) => { dragId.current = row.id; e.dataTransfer.setData("text/plain", row.id); e.dataTransfer.effectAllowed = "move" }} onDragEnd={() => { dragId.current = null }}
              className="grid size-7 shrink-0 cursor-grab place-items-center rounded-md text-text-muted"><GripVertical className="size-4" aria-hidden="true" /></button>
            <span className="text-sm text-text-muted">{index + 1}</span>
            <h2 className="min-w-0 break-words text-sm font-semibold">{row.name}</h2>
            <p className="order-last col-span-full min-w-0 break-words text-xs text-text-muted md:order-none md:col-span-1">{channels[row.channel]} · {list.automations.find((a) => a.id === row.automation_id)?.name ?? "Automação indisponível"}</p>
            <div className="flex shrink-0 items-center gap-2">
              <Switch checked={row.active} disabled={pending} aria-label={`Ativar regra ${row.name}`} onCheckedChange={(active) => toggleActive(row, active)} />
              <span className="sr-only text-xs text-text-muted md:not-sr-only md:w-12">{row.active ? "Ativa" : "Pausada"}</span>
            </div>
            <RowMenu item={row.name}>
              <RowMenuItem disabled={pending} onSelect={() => open(row)}>Editar</RowMenuItem>
              <RowMenuItem disabled={pending || index === 0} onSelect={() => void reorder(row.id, index - 1)}>Subir</RowMenuItem>
              <RowMenuItem disabled={pending || index === list.rows.length - 1} onSelect={() => void reorder(row.id, index + 1)}>Descer</RowMenuItem>
              <RowMenuItem className="text-danger" disabled={pending} onSelect={() => setDeleting(row)}>Excluir</RowMenuItem>
            </RowMenu>
          </div>
          {(() => { const shadow = shadowingRule(list.rows, row.id); return shadow ? <p className="mt-2 flex items-start gap-1.5 text-xs text-warning md:pl-[3.25rem]" data-testid="keyword-shadowed">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="break-words">{shadowMessage(shadow)} Para esta responder, suba-a acima dela ou pause a outra.</span></p> : null })()}
          {row.audience === "group" || row.rules.length ? <div className="mt-2 space-y-1.5 border-t border-border pt-2 text-sm md:pl-[3.25rem]">
            {row.audience === "group" && row.group_match && <p className="text-xs font-medium text-accent">Grupo · {groupModes[row.group_match]}</p>}
            {row.audience === "group" && !row.rules.length && <p className="text-xs">Qualquer mensagem que mencione o número.</p>}
            {row.rules.map((rule, n) => <div key={n} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <p className="break-words text-xs text-text-muted">{n > 0 && <strong className="text-accent">e </strong>}{conditionPhrase(rule.condition)}</p>
              {rule.condition !== "thumbs_up" && <ul role="list" aria-label={`Palavras de ${row.name}, condição ${n + 1}`} className="flex flex-wrap gap-1.5">{rule.words.map((word) => <li key={word}><TagChip label={word} /></li>)}</ul>}
            </div>)}
          </div> : null}
        </li>)}</ol></div>}
      <Dialog open={!!deleting} onOpenChange={(value) => { if (!value && !pending) setDeleting(null) }}>
        <DialogContent>
          <DialogTitle>Excluir regra?</DialogTitle>
          <DialogDescription className="break-words">A regra {deleting?.name} deixará de responder às próximas mensagens. A automação vinculada será preservada.</DialogDescription>
          <div className="flex justify-end gap-2"><Button variant="secondary" disabled={pending} onClick={() => setDeleting(null)}>Cancelar</Button><Button loading={pending} onClick={async () => { if (!deleting) return; const id = deleting.id; if (await mutate(() => deleteKeyword(workspace, id), "Regra excluída.")) setDeleting(null) }}>Excluir regra</Button></div>
          {error && <Banner variant="danger">{error} Tente de novo pelo botão de excluir.</Banner>}
        </DialogContent>
      </Dialog>
      <Dialog open={!!editing} onOpenChange={(value) => { if (!value && !pending) setEditing(null) }}>
        <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); opener.current?.focus() }} className="top-0 right-0 left-auto flex h-dvh w-full max-w-(--side-panel) translate-x-0 translate-y-0 rounded-none p-0 [&>button]:hidden">
          <DialogTitle className="sr-only">{editing?.id ? "Editar palavra-chave" : "Criar palavra-chave"}</DialogTitle>
          <DialogDescription className="sr-only">Configure palavras, canal e resposta.</DialogDescription>
          {input && <SidePanel title={editing?.id ? "Editar palavra-chave" : "Criar palavra-chave"} tone="neutral" onClose={() => { if (!pending) setEditing(null) }} className="border-0 rounded-none"
            footer={<PanelFooterBar switchLabel="Regra ativa" checked={input.active} disabled={pending || !publishedResponse} onCheckedChange={(active) => update({ active })}><Button type="submit" form="keyword-form" loading={pending} disabled={!input.automation_id}>Salvar palavra-chave</Button></PanelFooterBar>}>
            <form id="keyword-form" className="space-y-5" onSubmit={async (e) => { e.preventDefault(); if (!editing) return; setPending(true); setFormError(""); try { setCreatingResponse(false); await saveKeyword(workspace, { ...saveInput!, connection_id: effectiveConnection || null }, editing.id); setEditing(null); setNotice("Palavra-chave salva."); data.reload() } catch (err) { setFormError(err instanceof Error ? err.message : "Não foi possível salvar.") } finally { setPending(false) } }}>
              <fieldset disabled={pending} className="min-w-0 space-y-5">
                <div className="space-y-1"><label htmlFor="keyword-name">Nome da palavra-chave</label><Input id="keyword-name" required maxLength={120} value={input.name} onChange={(e) => update({ name: e.target.value })} /></div>
                <FieldSelect id="keyword-channel" label="Canal da mensagem" value={input.channel} disabled={input.audience === "group"} options={keywordChannels.map((channel) => ({ value: channel, label: channels[channel] }))} onChange={(channel) => update({ channel, audience: "direct" as const, group_match: null, connection_id: null, group_thread_id: null })} />
                {input.audience !== "group" && <FieldSelect id="keyword-direct-connection" label="Conexão da mensagem" value={effectiveConnection} required placeholder="Escolha uma conexão" options={eligibleConnections.map(c => ({ value: c.id, label: c.displayName ?? c.label }))} onChange={id => update({ connection_id: id || null })} hint={!eligibleConnections.length ? "Conecte uma conta que aceite mensagens para usar esta regra." : undefined} />}
                {(input.audience === "group" || list?.connections.some(c => c.kind === input.channel && c.profile?.groups?.reply)) && <KeywordGroupFields input={input} update={update} />}
                {input.rules.map((rule, index) => <div key={index} className="min-w-0 space-y-3 rounded-md border border-border bg-surface-muted p-3">
                  <div className="flex items-center justify-between gap-2"><p className="text-sm font-semibold">{index === 0 ? "Condição inicial" : "e também"}</p>
                    {(input.rules.length > 1 || input.group_match === "mention") && <button type="button" aria-label={`Remover condição ${index + 1}`} onClick={() => update({ rules: input.rules.filter((_, n) => index !== n) })} className="grid size-8 shrink-0 place-items-center rounded-md text-text-muted hover:bg-border/40 hover:text-text"><Trash2 className="size-4" aria-hidden="true" /></button>}</div>
                  <FieldSelect id={`condition-${index}`} label={`Condição ${index + 1}`} hideLabel value={rule.condition} options={keywordConditions.map((condition) => ({ value: condition.value, label: condition.label }))} onChange={(condition) => update({ rules: input.rules.map((r, n) => n === index ? { ...r, condition: condition as typeof r.condition, ...(condition === "thumbs_up" ? { words: [] } : {}) } : r) })} />
                  {rule.condition === "thumbs_up" ? <p className="text-xs text-text-muted">Responde quando a pessoa manda só o polegar para cima: o botão de curtir do Messenger ou o emoji 👍 nos outros canais.</p> : <>
                  <p className="text-sm text-text-muted">{conditionPhrase(rule.condition)}</p>
                  <KeywordChips label={`Palavras da condição ${index + 1}`} value={rule.words} onPendingChange={(text) => setPendingWords((old) => ({ ...old, [index]: text }))} onChange={(words) => update({ rules: input.rules.map((r, n) => n === index ? { ...r, words } : r) })} />
                  <p className="text-xs text-text-muted">Confirme cada palavra com Enter, vírgula ou saindo do campo. Até dez por condição; basta uma delas corresponder.</p></>}
                </div>)}
                <KeywordConflictNotice conflicts={conflicts} busy={pending} onPause={pauseOther} onRaise={editing?.id ? raiseThis : undefined} />
                <Button type="button" variant="ghost" className="self-start text-accent" disabled={input.rules.length >= 2} onClick={() => { if (input.rules.length < 2) update({ rules: [...input.rules, { condition: "contains", words: [] }] }) }}><Plus className="size-4" aria-hidden="true" />{input.rules.length ? "Adicionar condição com “e”" : "Responder só a certas palavras"}</Button>
                <p className="text-xs text-text-muted">Use até duas condições. A comparação aceita letras maiúsculas, minúsculas e palavras sem acento.</p>
                {!!reservedKeywordWords(input.rules).length && <Banner variant="warning">{reservedKeywordWords(input.rules).join(", ")}: palavras usadas pelo sistema para inscrição ou saída. Elas podem ter prioridade sobre esta regra.</Banner>}
                <div className="space-y-1"><p className="text-sm font-medium">Automação de resposta</p><AutomationPicker workspace={workspace} automations={list?.automations} value={input.automation_id} onChange={(automation_id) => update({ automation_id, active: input.active && !!list?.automations.find(a => a.id === automation_id)?.published_version_id })} clearLabel="Remover automação de resposta" buttonAriaLabel="Automação de resposta" /></div>
                {input.automation_id && <KeywordAutomationPreview workspace={workspace} id={input.automation_id} />}
                <div className="space-y-2"><Button type="button" variant="secondary" className="w-full" disabled={!canCreateResponse} onClick={() => void createResponse()}><Plus className="size-4" aria-hidden="true" />Criar automação</Button><p className="text-xs text-text-muted">Salva a regra pausada e abre o editor da nova resposta.</p></div>
                {!publishedResponse && <p className="text-xs text-text-muted">A regra só pode ser ativada com uma automação de resposta publicada.</p>}
              </fieldset>
              {formError && <Banner variant="danger">{formError} <Button type={creatingResponse ? "button" : "submit"} onClick={creatingResponse ? () => void createResponse() : undefined} form="keyword-form" variant="secondary" size="sm">Tentar de novo</Button></Banner>}
            </form>
          </SidePanel>}
        </DialogContent>
      </Dialog>
    </div>
  )
}
