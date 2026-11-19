import { Link } from "react-router"
import { ArrowUpRight, MessageSquare } from "lucide-react"
import { getAutomation } from "@/data"
import { useAsync } from "@/hooks/use-async"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"

/** Só lê o conteúdo publicado (ou o rascunho ainda sem publicação); nunca executa ações. */
export function KeywordAutomationPreview({ workspace, id }: { workspace: string; id: string }) {
  const data = useAsync(() => getAutomation(workspace, id), `${workspace}:${id}`)
  const detail = data.data
  const graph = detail?.published_version?.graph ?? detail?.automation.draft_graph
  const texts = graph?.nodes.flatMap(node => Array.isArray(node.config.blocks)
    ? node.config.blocks.flatMap((block: { kind: string; text?: string }) => block.kind === "text" && block.text ? [block.text] : []) : []) ?? []
  return <section aria-label="Prévia da automação" className="space-y-3 rounded-md border border-border bg-surface-muted p-3">
    <h3 className="flex items-center gap-2 text-sm font-semibold"><MessageSquare className="size-4" aria-hidden="true" />Prévia da automação</h3>
    {data.loading ? <p role="status" className="text-sm text-text-muted">Carregando resposta…</p>
      : data.error ? <Banner variant="danger">Não foi possível carregar a prévia.<Button type="button" variant="secondary" size="sm" onClick={data.reload}>Tentar de novo</Button></Banner>
      : !detail ? <p className="text-sm text-text-muted">Esta automação não está disponível.</p>
      : <>
        <p className="break-words text-sm font-medium">{detail.automation.name}</p>
        <p className="text-xs text-text-muted">{detail.published_version ? "Conteúdo publicado" : "Rascunho · publique antes de ativar a regra"}</p>
        {texts.length ? <div className="max-h-48 space-y-2 overflow-y-auto">{texts.map((text, i) => <p key={i} className="whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-3 text-sm">{text}</p>)}</div>
          : <p className="text-sm text-text-muted">Ainda sem texto de resposta. Prepare o conteúdo no editor.</p>}
        <Link to={`/${workspace}/automations/${id}`} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">Abrir editor<ArrowUpRight className="size-4" aria-hidden="true" /></Link>
      </>}
  </section>
}
