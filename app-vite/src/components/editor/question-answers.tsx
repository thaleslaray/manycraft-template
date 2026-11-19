import * as React from "react"
import { Download, Table } from "lucide-react"
import { toast } from "sonner"
import { apiRequest, getWorkspace, isFakeMode } from "@/data/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

type Answer = { answered_at: string | null; question: string; value: unknown; contact_id: string; contact_name: string; email: string | null; phone: string | null }

/** Respostas aceitas desta pergunta (publicada): tabela no painel e download em CSV. */
export function QuestionAnswers({ automationId, nodeId }: { automationId?: string; nodeId: string }) {
  const [rows, setRows] = React.useState<Answer[] | null>(null)
  const [open, setOpen] = React.useState(false)
  if (!automationId || isFakeMode()) return null
  const path = `/automations/${encodeURIComponent(automationId)}/answers?node=${encodeURIComponent(nodeId)}`
  async function show() {
    setOpen(true); setRows(null)
    try { setRows(await apiRequest<Answer[]>(path)) } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível carregar as respostas."); setOpen(false) }
  }
  async function download() {
    try {
      const { workspace_id } = await getWorkspace()
      const response = await fetch(`/api${path}&format=csv`, { headers: { "x-workspace": workspace_id } })
      if (!response.ok) { toast.error("Não foi possível exportar."); return }
      const url = URL.createObjectURL(await response.blob())
      const link = Object.assign(document.createElement("a"), { href: url, download: `respostas-${nodeId}.csv` })
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível exportar.") }
  }
  return <>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onClick={show}><Table className="size-4" aria-hidden="true" />Ver respostas</Button>
      <Button size="sm" variant="ghost" onClick={download}><Download className="size-4" aria-hidden="true" />Exportar CSV</Button>
    </div>
    {open ? <Dialog open onOpenChange={o => !o && setOpen(false)}>
      <DialogContent className="max-w-(--modal-lg)">
        <DialogHeader><DialogTitle>Respostas da pergunta</DialogTitle><DialogDescription>Respostas aceitas, mais recentes primeiro (até 5.000).</DialogDescription></DialogHeader>
        {rows === null ? <p role="status">Carregando…</p> : rows.length === 0 ? <p className="text-sm text-text-muted">Ninguém respondeu ainda.</p> :
          <div className="max-h-[60dvh] overflow-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-text-muted"><tr><th className="p-2">Quando</th><th className="p-2">Contato</th><th className="p-2">Resposta</th></tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-border"><td className="p-2 whitespace-nowrap">{r.answered_at ? new Date(r.answered_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—"}</td><td className="p-2">{r.contact_name || r.email || r.phone || r.contact_id}</td><td className="p-2 break-words">{typeof r.value === "object" ? JSON.stringify(r.value) : String(r.value ?? "")}</td></tr>)}</tbody></table></div>}
      </DialogContent>
    </Dialog> : null}
  </>
}
