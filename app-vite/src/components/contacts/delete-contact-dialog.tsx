import * as React from "react"
import { toast } from "sonner"
import { bulkDeleteContacts, deleteContact, type ContactDeletion } from "@/data"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** A mesma confirmação protege a exclusão no perfil, na conversa e em lote. */
export function DeleteContactDialog({ workspace, ids, name, bulk = false, onClose, onDeleted }: {
  workspace: string
  ids: string[]
  name?: string
  bulk?: boolean
  onClose: () => void
  onDeleted: (result: ContactDeletion) => void
}) {
  const [word, setWord] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const inputId = React.useId()
  const hintId = React.useId()
  const validCount = ids.length > 0 && ids.length <= 100
  const allowed = word === "EXCLUIR" && validCount && !busy
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!allowed) return
    setBusy(true)
    setError(null)
    try {
      const result = bulk ? await bulkDeleteContacts(workspace, ids) : await deleteContact(workspace, ids[0])
      toast.success(result.deleted_ids.length === 1 ? "Dados do contato excluídos." : `Dados de ${result.deleted_ids.length} contatos excluídos.`)
      onDeleted(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível excluir os dados.")
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto" onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
        <form onSubmit={submit} className="space-y-4" aria-busy={busy}>
          <DialogHeader>
            <DialogTitle>{bulk ? "Excluir contatos selecionados" : "Excluir contato"}</DialogTitle>
            <DialogDescription className="break-words">{name ? `Você está excluindo os dados de ${name}.` : `${ids.length} ${ids.length === 1 ? "contato selecionado" : "contatos selecionados"}.`} Esta ação não pode ser desfeita.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>Nome, identificação nos canais, tags, campos, conversas e itens da linha do tempo deste painel serão removidos. As execuções de automação em andamento serão canceladas.</p>
            <p>As estatísticas das automações serão preservadas, sem os dados pessoais do contato.</p>
            <p>O histórico no aplicativo do canal, como o Telegram, continuará lá. Ao enviar outra mensagem, a pessoa entrará como um novo contato e poderá receber as boas-vindas novamente.</p>
          </div>
          {!validCount ? <Banner variant="danger">Selecione de 1 a 100 contatos por vez.</Banner> : null}
          {error ? <Banner variant="danger"><p role="alert">{error}</p></Banner> : null}
          <div className="space-y-2">
            <Label htmlFor={inputId}>Digite EXCLUIR para confirmar</Label>
            <Input id={inputId} value={word} onChange={event => setWord(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} aria-describedby={hintId} />
            <p id={hintId} className="text-xs text-text-muted">Use a palavra em letras maiúsculas.</p>
          </div>
          <DialogFooter className="flex-wrap">
            <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Voltar</Button>
            <Button type="submit" variant="danger" loading={busy} disabled={!allowed}>{error ? "Tentar de novo" : busy ? "Excluindo dados…" : "Excluir dados"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
