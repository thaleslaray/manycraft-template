import * as React from "react"
import { Link } from "react-router"
import { Loader2, Workflow } from "lucide-react"
import { listCalledBy, type CalledBy } from "@/data/called-by"
import { Button } from "@/components/ui/button"

/** Quem chama esta automação: cada linha abre a automação que tem o passo "Iniciar automação" apontando para cá. */
export function CalledByList({ automationId, workspace }: { automationId: string; workspace: string }) {
  const [rows, setRows] = React.useState<CalledBy[] | null>(null)
  const [error, setError] = React.useState(false)
  const [retry, setRetry] = React.useState(0)
  React.useEffect(() => {
    let active = true
    setRows(null); setError(false)
    listCalledBy(automationId).then(result => { if (active) setRows(result) }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [automationId, retry])
  return (
    <section aria-label="Chamada por" className="mt-5 space-y-2 border-t border-border pt-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Workflow className="size-4 text-text-muted" aria-hidden="true" />Chamada por</h3>
      {error ? <div role="alert" className="space-y-2 text-sm text-danger"><p>Não consegui ver quem chama esta automação.</p><Button variant="secondary" size="sm" onClick={() => setRetry(retry + 1)}>Tentar novamente</Button></div>
        : rows === null ? <p role="status" className="flex items-center gap-2 text-xs text-text-muted"><Loader2 className="size-3 animate-spin" aria-hidden="true" />Carregando…</p>
        : !rows.length ? <p className="text-xs leading-relaxed text-text-muted">Nenhuma automação publicada inicia esta pelo passo “Iniciar automação”.</p>
        : <ul className="space-y-1">{rows.map(row => <li key={row.id}>
          <Link to={`/${workspace}/automations/${encodeURIComponent(row.id)}`} className="flex min-h-9 flex-col justify-center rounded-md px-2 py-1 text-sm hover:bg-surface-muted focus-visible:outline-accent">
            <span className="break-words font-medium">{row.name}</span>
            <span className="text-xs text-text-muted">{row.waits ? "Espera esta terminar e volta" : "Segue sem esperar"}</span>
          </Link></li>)}</ul>}
    </section>
  )
}
