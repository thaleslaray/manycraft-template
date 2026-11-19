import * as React from "react"
import { useParams } from "react-router"
import { Background, ReactFlow, ReactFlowProvider } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { toFlow } from "@/components/editor/graph"
import { nodeTypes } from "@/components/editor/nodes"
import { EditorProvider } from "@/components/editor/editor-context"
import { Button } from "@/components/ui/button"
import { apiRequest } from "@/data/api"
import type { Graph } from "@/data"

type Shared = { name: string; graph: Graph; allow_copy: boolean }

/** Link público de uma automação: mostra o mapa só para leitura e permite salvar uma cópia na própria conta (exige entrar). */
export function SharedAutomationPage() {
  const { token = "" } = useParams()
  const [data, setData] = React.useState<Shared | null | undefined>(undefined)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  React.useEffect(() => { fetch(`/api/automation-share/${encodeURIComponent(token)}`).then(r => r.ok ? r.json() : null).then(setData).catch(() => setData(null)) }, [token])
  if (data === undefined) return <p role="status" className="p-6 text-text-muted">Carregando…</p>
  if (!data) return <p role="alert" className="p-6">Este link de automação não existe mais.</p>
  const flow = toFlow(data.graph)
  return <div className="flex h-screen flex-col bg-bg">
    <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-6 py-3">
      <h1 className="text-lg font-semibold">{data.name}</h1>
      <span className="text-sm text-text-muted">Automação compartilhada · só leitura</span>
      {data.allow_copy ? <Button className="ml-auto" loading={busy} onClick={async () => {
        setBusy(true); setError("")
        try { const r = await apiRequest<{ id: string }>("/automations/import-shared", { method: "POST", body: JSON.stringify({ token }) }); window.location.assign(`/?automacao=${r.id}`) }
        catch { setError("Entre na sua conta para salvar uma cópia."); setBusy(false) }
      }}>Salvar na minha conta</Button> : null}
    </header>
    {error ? <p role="alert" className="px-6 py-2 text-sm text-danger">{error} <a className="underline" href="/login">Entrar</a></p> : null}
    <div className="min-h-0 flex-1"><EditorProvider value={{ readOnly: true, stats: null, triggers: [], tags: [], errors: {}, showErrors: false }}><ReactFlowProvider><ReactFlow nodes={flow.nodes.map(n => ({ ...n, draggable: false }))} edges={flow.edges} nodeTypes={nodeTypes} nodesConnectable={false} elementsSelectable={false} fitView proOptions={{ hideAttribution: true }}>
      <Background />
    </ReactFlow></ReactFlowProvider></EditorProvider></div>
  </div>
}
