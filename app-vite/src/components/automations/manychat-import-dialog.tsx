import * as React from "react"
import { useNavigate } from "react-router"
import { AlertTriangle, ArrowRight, CheckCircle2, Download, Info, XCircle } from "lucide-react"
import { importManychatClipboard, importManychatShared, looksLikeManychatShare, type ManychatImportResult } from "@/data/manychat-import"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { FieldSelect } from "@/components/ui/field-select"
import { Input } from "@/components/ui/input"

const nodeLabels: Record<string, [string, string]> = {
  message: ["mensagem", "mensagens"], question: ["pergunta", "perguntas"], action: ["passo de ações", "passos de ações"], condition: ["condição", "condições"],
  smart_delay: ["espera", "esperas"], randomizer: ["divisão aleatória", "divisões aleatórias"], start_automation: ["“iniciar outra automação”", "“iniciar outra automação”"], note: ["nota", "notas"],
}
const referenceLabels = { tag: "Etiqueta", field: "Campo", sequence: "Sequência" } as const
const triggerLabels: Record<string, string> = { comment: "Comentário", keyword: "Palavra-chave" }

function plural(n: number, [one, many]: [string, string]) { return `${n} ${n === 1 ? one : many}` }

/** Importa um fluxo pelo link de compartilhamento da ManyChat e mostra o que entrou e o que ficou de fora. */
export function ManychatImportDialog({ workspace, folders, folderId, onClose, onImported, pasted }: {
  workspace: string; folders: { id: string; label: string }[]; folderId: string | null; onClose: () => void; onImported?: () => void
  /** Blocos colados (Cmd+V) da ManyChat: importa direto, sem pedir link. */
  pasted?: unknown
}) {
  const navigate = useNavigate()
  const [link, setLink] = React.useState("")
  const [name, setName] = React.useState("")
  const [folder, setFolder] = React.useState(folderId ?? "")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [result, setResult] = React.useState<ManychatImportResult>()

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!looksLikeManychatShare(link)) { setError("Link inválido. Cole o link de compartilhamento da ManyChat (começa com https://app.manychat.com/)."); return }
    setBusy(true); setError(undefined)
    try {
      const out = await importManychatShared({ share_url: link.trim(), ...(name.trim() ? { name: name.trim() } : {}), folder_id: folder || null })
      setResult(out); onImported?.()
    } catch (e) { setError(e instanceof Error ? e.message : "Não foi possível importar. Tente novamente.") }
    finally { setBusy(false) }
  }

  // Colou blocos da ManyChat: importa na hora, na pasta aberta, e mostra o relatório.
  const started = React.useRef(false)
  React.useEffect(() => {
    if (!pasted || started.current) return
    started.current = true
    setBusy(true)
    importManychatClipboard({ clipboard: pasted, name: "Colado da ManyChat", folder_id: folderId })
      .then(out => { setResult(out); onImported?.() })
      .catch(e => setError(e instanceof Error ? e.message : "Não foi possível importar os blocos colados."))
      .finally(() => setBusy(false))
  }, [pasted, folderId, onImported])

  const open = () => { if (result) navigate(`/${workspace}/automations/${result.automation.id}`) }

  return <Dialog open onOpenChange={next => { if (!next && !busy) onClose() }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{result ? (result.created ? "Fluxo importado" : "Fluxo reimportado") : pasted ? "Colando da ManyChat" : "Importar da ManyChat"}</DialogTitle>
        <DialogDescription>{result
          ? `“${result.automation.name}” foi salva como rascunho. Revise antes de publicar.`
          : pasted ? "Os blocos que você copiou na ManyChat viram uma automação em rascunho, sem enviar nada."
          : "Cole o link de compartilhamento de um fluxo da ManyChat. A automação entra como rascunho, sem enviar nada."}</DialogDescription>
      </DialogHeader>
      {result ? <Report result={result} /> : pasted ? <div className="space-y-3 text-sm">
        {busy ? <p className="text-text-muted" role="status">Importando os blocos colados da ManyChat…</p> : null}
        {error ? <Banner variant="danger">{error}</Banner> : null}
      </div> : <form id="manychat-import" onSubmit={submit} className="space-y-4">
        <label className="block space-y-2 text-sm font-semibold">Link do fluxo compartilhado
          <Input aria-label="Link do fluxo compartilhado" autoFocus required maxLength={500} placeholder="https://app.manychat.com/flowPlayerPage?share_hash=…" value={link} disabled={busy} onChange={e => { setLink(e.target.value); setError(undefined) }} />
          <span className="block text-xs font-normal text-text-muted">Na ManyChat: abra o fluxo, clique em Compartilhar e copie o link. A opção de permitir cópia precisa estar ligada.</span>
        </label>
        <label className="block space-y-2 text-sm font-semibold">Nome da automação (opcional)
          <Input aria-label="Nome da automação" maxLength={120} placeholder="Usa o nome do fluxo na ManyChat" value={name} disabled={busy} onChange={e => setName(e.target.value)} />
        </label>
        <FieldSelect id="manychat-import-folder" label="Pasta (opcional)" value={folder} none="Sem pasta" disabled={busy} options={folders.map(f => ({ value: f.id, label: f.label }))} onChange={setFolder} />
        {error ? <Banner variant="danger">{error}</Banner> : null}
      </form>}
      <DialogFooter>
        {result
          ? <><Button variant="secondary" onClick={onClose}>Fechar</Button><Button onClick={open}>Abrir automação em rascunho<ArrowRight className="size-4" /></Button></>
          : pasted ? <Button variant="secondary" disabled={busy} onClick={onClose}>Fechar</Button>
          : <><Button variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" form="manychat-import" loading={busy} disabled={!link.trim()}><Download className="size-4" />Importar</Button></>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

function Report({ result }: { result: ManychatImportResult }) {
  const counts = result.automation.draft_graph.nodes.reduce<Record<string, number>>((acc, n) => n.type === "trigger" ? acc : { ...acc, [n.type]: (acc[n.type] ?? 0) + 1 }, {})
  const loss = result.report.items.filter(i => i.level === "loss")
  const attention = result.report.items.filter(i => i.level === "attention")
  // A importação por colagem não traz mídias nem gatilhos (só a do link): ausência é lista vazia.
  const references = result.references ?? [], media = result.media ?? [], triggers = result.triggers ?? []
  const createdRefs = references.filter(r => r.created)
  const failedMedia = media.filter(m => m.status === "failed")
  const okMedia = media.length - failedMedia.length
  const triggersIn = triggers.filter(t => t.status === "created")
  const triggersOut = triggers.filter(t => t.status === "skipped")
  const group = (items: typeof loss) => [...new Map(items.map(i => [`${i.code}|${i.message}`, { ...i, n: items.filter(j => j.code === i.code && j.message === i.message).length }])).values()]
  return <div className="space-y-4 text-sm" aria-label="Relatório da importação">
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 font-semibold"><CheckCircle2 className="size-4 text-success" aria-hidden="true" />O que entrou</h3>
      <ul className="list-disc space-y-1 pl-6">
        <li>{result.report.nodes_in} {result.report.nodes_in === 1 ? "passo" : "passos"} na ManyChat viraram {Object.entries(counts).map(([type, n]) => plural(n, nodeLabels[type] ?? [type, type])).join(", ") || "nenhum passo"}.</li>
        {createdRefs.length ? <li>Criados: {createdRefs.map(r => `${referenceLabels[r.kind]} “${r.name}”`).join(", ")}.</li> : null}
        {references.length > createdRefs.length ? <li>{references.length - createdRefs.length} {references.length - createdRefs.length === 1 ? "referência já existia e foi reaproveitada" : "referências já existiam e foram reaproveitadas"}.</li> : null}
        {okMedia ? <li>{okMedia} {okMedia === 1 ? "mídia copiada" : "mídias copiadas"} para o seu armazenamento.</li> : null}
        {triggersIn.map(t => <li key={`${t.kind}-${t.name}`}>Gatilho “{t.name}” ({triggerLabels[t.kind] ?? t.kind}) criado desligado.{t.notes?.length ? ` ${t.notes.join(" ")}` : ""}</li>)}
        {result.resolved_incoming_links ? <li>{result.resolved_incoming_links} {result.resolved_incoming_links === 1 ? "automação importada antes passou" : "automações importadas antes passaram"} a apontar para esta.</li> : null}
      </ul>
    </section>
    {loss.length || triggersOut.length || failedMedia.length ? <section className="space-y-2">
      <h3 className="flex items-center gap-2 font-semibold"><XCircle className="size-4 text-danger" aria-hidden="true" />O que ficou de fora</h3>
      <ul className="list-disc space-y-1 pl-6">
        {group(loss).map(i => <li key={`${i.code}|${i.message}`}>{i.message}{i.n > 1 ? ` (${i.n}×)` : ""}</li>)}
        {triggersOut.map(t => <li key={`${t.kind}-${t.name}`}>Gatilho “{t.name}”: {t.reason}</li>)}
        {failedMedia.map(m => <li key={m.source_url}>Mídia não copiada ({m.reason ?? "erro"}); o passo ainda aponta para a ManyChat.</li>)}
      </ul>
    </section> : null}
    {attention.length ? <section className="space-y-2">
      <h3 className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4 text-warning" aria-hidden="true" />Para conferir antes de publicar</h3>
      <ul className="list-disc space-y-1 pl-6">{group(attention).map(i => <li key={`${i.code}|${i.message}`}>{i.message}{i.n > 1 ? ` (${i.n}×)` : ""}</li>)}</ul>
    </section> : null}
    {!loss.length && !attention.length && !triggersOut.length && !failedMedia.length ? <p className="flex items-center gap-2 text-text-muted"><Info className="size-4" aria-hidden="true" />Nada ficou de fora.</p> : null}
  </div>
}
