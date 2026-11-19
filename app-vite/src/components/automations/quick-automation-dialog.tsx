import * as React from "react"
import { FieldSelect } from "@/components/ui/field-select"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import { listConnections } from "@/data"
import { useAsync } from "@/hooks/use-async"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { KeywordChips } from "@/components/ui/keyword-chips"
import { withPending } from "@/components/ui/keyword-merge"
import { eligibleConnections, type UseCase } from "@/data/use-cases"

const goals = { keyword: "Responder quem manda uma palavra no privado", comment: "Mandar DM para quem comenta uma palavra", story_mention: "Agradecer quem menciona a conta no story" } as const
type Goal = keyof typeof goals

/**
 * Automações rápidas: três passos (objetivo, palavras e conexão, mensagem) e a automação sai publicada e ligada.
 * Com um caso de uso pronto, o objetivo, as palavras, o nome, a mensagem e o texto do botão já vêm preenchidos:
 * sobram dois passos (palavra e canal, mensagem e link) e a escolha entre publicar agora ou guardar como rascunho.
 */
export function QuickAutomationDialog({ workspace, onClose, useCase }: { workspace: string; onClose: () => void; useCase?: UseCase }) {
  const navigate = useNavigate()
  const first = useCase ? 2 : 1
  const [step, setStep] = React.useState(first)
  const [goal, setGoal] = React.useState<Goal>(useCase?.goal ?? "keyword")
  const [name, setName] = React.useState(useCase?.name ?? "")
  const [words, setWords] = React.useState<string[]>(useCase?.words ?? [])
  const [pendingWord, setPendingWord] = React.useState("")
  const [connection, setConnection] = React.useState("")
  const [message, setMessage] = React.useState(useCase?.message ?? "")
  const [label, setLabel] = React.useState(useCase?.buttonLabel ?? "")
  const [publish, setPublish] = React.useState(true)
  const [url, setUrl] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [dedupe, setDedupe] = React.useState("Respondeu menção")
  const connections = useAsync(() => listConnections(workspace), "quick-connections")
  const eligible = eligibleConnections(goal, connections.data ?? [])
  // Um caso pronto com um único canal compatível já vem com ele escolhido.
  React.useEffect(() => { if (useCase && !connection && eligible.length === 1) setConnection(eligible[0].id) }, [useCase, connection, eligible])
  const needsLink = Boolean(useCase?.buttonLabel)
  async function finish() {
    setBusy(true)
    try {
      if (isFakeMode()) throw new Error("O assistente precisa do motor conectado.")
      const r = await apiRequest<{ automation_id: string }>("/quick-automations", { method: "POST", body: JSON.stringify({ goal, name: name.trim() || goals[goal], connection_id: connection, words, message, ...(goal === "story_mention" && dedupe.trim() ? { dedupe_tag: dedupe.trim() } : {}), publish, ...(label.trim() && url.trim() ? { button: { label: label.trim(), url: url.trim() } } : {}) }) })
      toast.success(publish ? "Automação criada, publicada e ligada." : "Rascunho criado. Revise e publique quando quiser.")
      navigate(`/${workspace}/automations/${r.automation_id}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível criar a automação.") }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => !open && !busy && onClose()}>
    <DialogContent>
      <DialogHeader><DialogTitle>{useCase ? useCase.title : "Automação rápida"} · passo {step - first + 1} de {4 - first}</DialogTitle><DialogDescription>{useCase ? "Já deixamos o caso montado. Falta só o que é seu. Depois você pode editar tudo no editor." : "Responda três perguntas e a automação fica pronta. Depois você pode editar tudo no editor."}</DialogDescription></DialogHeader>
      {step === 1 ? <fieldset className="space-y-2"><legend className="mb-1 text-sm font-medium">O que você quer automatizar?</legend>
        {(Object.keys(goals) as Goal[]).map(g => <label key={g} className="flex items-center gap-2 rounded-md border border-border p-3 text-sm"><input type="radio" name="goal" checked={goal === g} onChange={() => { setGoal(g); setConnection("") }} className="accent-accent" />{goals[g]}</label>)}
      </fieldset> : step === 2 ? <div className="space-y-3">
        {goal === "story_mention" ? <div className="space-y-1"><Label htmlFor="quick-dedupe">Etiqueta para responder só uma vez (opcional)</Label><Input id="quick-dedupe" value={dedupe} maxLength={190} onChange={e => setDedupe(e.target.value)} />
          <p className="text-xs text-text-muted">Quem já tem a etiqueta não recebe de novo, mesmo mencionando outra vez.</p></div>
          : <KeywordChips label={goal === "comment" ? "Palavras do comentário" : "Palavras da mensagem"} value={words} onChange={setWords} onPendingChange={setPendingWord} />}
        <div className="space-y-1"><FieldSelect id="quick-connection" label="Conexão" value={connection} placeholder="Escolha a conexão" options={eligible.map(c => ({ value: c.id, label: c.displayName ?? c.label }))} onChange={setConnection} />
          {!connections.loading && !eligible.length ? <p className="text-xs text-text-muted">Nenhuma conexão aceita este objetivo ainda. Conecte um canal em Configurações.</p> : null}</div>
      </div> : <div className="space-y-3">
        <div className="space-y-1"><Label htmlFor="quick-name">Nome da automação</Label><Input id="quick-name" value={name} maxLength={100} placeholder={goals[goal]} onChange={e => setName(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="quick-message">Mensagem enviada</Label><Textarea id="quick-message" rows={4} maxLength={1000} value={message} onChange={e => setMessage(e.target.value)} /></div>
        <div className="grid grid-cols-[8rem_1fr] gap-2"><div className="space-y-1"><Label htmlFor="quick-label">Botão (opcional)</Label><Input id="quick-label" value={label} maxLength={20} onChange={e => setLabel(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="quick-url">{needsLink ? "Link do botão (obrigatório)" : "Link do botão"}</Label><Input id="quick-url" type="url" placeholder="https://" value={url} onChange={e => setUrl(e.target.value)} /></div></div>
        <fieldset className="space-y-1"><legend className="text-sm font-medium">Quando a automação vai ao ar?</legend>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="quick-publish" className="accent-accent" checked={publish} onChange={() => setPublish(true)} />Publicar e ligar agora</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="quick-publish" className="accent-accent" checked={!publish} onChange={() => setPublish(false)} />Salvar como rascunho para revisar antes</label></fieldset>
      </div>}
      <DialogFooter>
        <Button variant="secondary" disabled={busy} onClick={() => step === first ? onClose() : setStep(step - 1)}>{step === first ? "Cancelar" : "Voltar"}</Button>
        {step < 3 ? <Button disabled={step === 2 && ((goal !== "story_mention" && !withPending(words, pendingWord).length) || !connection)} onClick={() => { setWords(withPending(words, pendingWord)); setPendingWord(""); setStep(step + 1) }}>Continuar</Button>
          : <Button loading={busy} disabled={!message.trim() || (needsLink && !url.trim())} onClick={() => void finish()}>{publish ? "Criar e ligar" : "Salvar rascunho"}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
