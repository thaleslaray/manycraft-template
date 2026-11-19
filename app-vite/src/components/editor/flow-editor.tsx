import { getPendingTrigger } from "./pending-trigger"
import "@xyflow/react/dist/style.css"
import * as React from "react"
import { listActionMembers } from "@/data/editor-actions"
import { listConnections } from "@/data/connections"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { listSequences } from "@/data/sequences"
import { Link, useParams } from "react-router"
import { useCan } from "@/hooks/use-role"
import {
  Background,
  BackgroundVariant,
  Controls,
  ControlButton,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  type OnSelectionChangeParams,
} from "@xyflow/react"
import { channelGlyphs } from "./channel-badge"
import { Activity, ChevronRight, CircleHelp, Clock, EllipsisVertical, Check, Grid3x3, LayoutGrid, ListTree, Lock, LockOpen, MessageSquare, Pause, Pencil, Play, Plus, Redo2, Share2, Shuffle, Smartphone, Tags, Undo2, Workflow, GitBranch, Zap, Braces, FileText, StickyNote, Group, Link2, Link2Off } from "lucide-react"
import { toast } from "sonner"
import { apiRequest, getWorkspace } from "@/data/api"
import { autoLayout, copySelection, History, pasteClip } from "./clipboard"
import { useEditorClipboard, type EditorKeyActions } from "./use-editor-clipboard"
import { LockMenu, StepItem, StepList } from "./flow-editor-parts"
import { FIT_OPTIONS, mapViewport, NARROW_MAP } from "./map-fit"
import {
  automationStats,
  getAutomation,
  listTags,
  listEditorFields,
  listAutomations,
  publishAutomation,
  renameAutomation,
  saveDraft,
  setAutomationStatus,
  lockedActionsOf,
  revokeAutomationShare,
  setExternalTriggerState,
  listKeywords,
  moveKeyword,
  setKeywordActive,
  type Automation,
  type AutomationStats,
  type Tag,
  type Trigger,
} from "@/data"
import { listSegments } from "@/data/segments"
import { conditionFromEngineRule, conflictMessage, findKeywordConflicts, type KeywordConflict } from "@/data/keyword-conflicts"
import { useAsync } from "@/hooks/use-async"
import { PendingList } from "./pending-list"
import { pendingSteps } from "./pending"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusBadge } from "@/components/ui/status-badge"
import { EditorProvider } from "./editor-context"
import {
  defaultConfig,
  edgeId,
  PORT_THEN,
  stepIdPrefix,
  graphSnapshot,
  getActions,
  newId,
  nodeTitle,
  stepAriaLabel,
  creationTitle,
  outputPorts,
  type EditableNodeType,
  toFlow,
  completeGraph,
  separateByHeight,
  toGraph,
  validateGraph,
  type FlowEdge,
  type FlowNode,
} from "./graph"
import { nodeTypes } from "./nodes"
import { PanelHost } from "./panel-host"
import { NewTriggerDialog, type NewTriggerChoice } from "./new-trigger-dialog"
import { AnnotationPanel } from "./annotation-panel"
import { ChannelCompatibility } from "./channel-compatibility"
import { assignStepChannels, availableStepChannels, PENDING_CHANNEL, stepChannelLabels, type StepChannel } from "./step-channel"
import { StepChannelDialog } from "./step-channel-dialog"
import { inferredStepChannel } from "./step-channel"
import { annotationAriaLabel, annotationLabels, createAnnotation, dragGroup, isAnnotation, removedSummary, startGroupDrag, clampSize, type AnnotationKind, type GroupDrag } from "./annotations"
import { TriggerMetrics } from "./trigger-metrics"
import { MobileSteps } from "./mobile-steps"
import type { Graph } from "@/data/types"
import { BROADCAST_START_ID } from "./broadcast-start-node"
import { AutomationPreview } from "./automation-preview"
import { dropStepPosition, FIRST_STEP_GAP, needsFirstStep, opensDropMenu, stepCatalog, type DropItem } from "./connect-drop"
import { ConnectDropMenu, DropAnchorNode, DROP_ANCHOR_ID, FIRST_STEP_ID, FirstStepNode, type FirstStepData } from "./connect-drop-menu"

// Tipos do mapa: os passos, o nó invisível que segura a ponta do conector solto no vazio e o cartão do primeiro passo.
const mapNodeTypes = { ...nodeTypes, connect_drop: DropAnchorNode, first_step: FirstStepNode }

/**
 * Mapa de fluxo usado fora da automação (conteúdo da transmissão): o mesmo mapa, nós e painéis, sem barra de título, gatilho
 * nem publicação. O fluxo vive no `graph` de quem hospeda; cada mudança volta por `onChange`.
 */
export type FlowHost = { graph: Graph; channel?: StepChannel; onChange: (graph: Graph) => void; label: string
  /** Só leitura (relatório): sem painéis de edição nem avisos de versão publicada; `stats` pinta os números em cada nó. */
  readOnly?: boolean; stats?: AutomationStats | null
  /** Etiquetas que o hospedeiro já tem (a transmissão recebe em /broadcasts/options): o mapa abre sem esperar um GET /tags. */
  tags?: Tag[] }

type Loaded = { automation: Automation; triggers: Trigger[]; stats: AutomationStats | null; tags: Tag[]; published: Automation["draft_graph"] | null }

const ariaLabels = {
  "node.a11yDescription.default": "Enter abre as opções do passo. Delete remove. Esc cancela.",
  "node.a11yDescription.keyboardDisabled": "Enter seleciona o passo. Depois, as setas movem. Delete remove.",
  "node.a11yDescription.ariaLiveMessage": ({ direction }: { direction: string; x: number; y: number }) => `Passo movido (${direction}).`,
  "edge.a11yDescription.default": "Enter seleciona a ligação. Delete remove.",
  "controls.ariaLabel": "Controles do mapa",
  "controls.zoomIn.ariaLabel": "Aproximar",
  "controls.zoomOut.ariaLabel": "Afastar",
  "controls.fitView.ariaLabel": "Enquadrar tudo",
  "controls.interactive.ariaLabel": "Alternar edição",
  "minimap.ariaLabel": "Minimapa",
  "handle.ariaLabel": "Porta",
}

function useIsDesktop() {
  return React.useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia("(min-width: 48rem)")
      m.addEventListener("change", cb)
      return () => m.removeEventListener("change", cb)
    },
    () => window.matchMedia("(min-width: 48rem)").matches,
    () => true
  )
}


export function AutomationEditor() {
  const { workspace, id } = useParams() as { workspace: string; id: string }
  const desktop = useIsDesktop()
  const q = useAsync<Loaded | null>(async () => {
    const [detail, stats, tags] = await Promise.all([
      getAutomation(workspace, id),
      automationStats(id, 30).catch(() => null),
      listTags(workspace),
    ])
    return detail ? { automation: { ...detail.automation, draft_graph: completeGraph(detail.automation.draft_graph) }, triggers: detail.triggers, stats, tags,
      published: detail.published_version?.graph ? completeGraph(detail.published_version.graph) : null } : null
  }, `${workspace}|${id}`)

  if (q.error)
    return (
      <Banner variant="danger">
        <span className="mr-3">Não consegui abrir a automação.</span>
        <Button size="sm" variant="secondary" onClick={q.reload}>
          Tentar de novo
        </Button>
      </Banner>
    )
  if (q.loading)
    return (
      <div aria-busy="true" aria-label="Carregando editor" className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  if (!q.data)
    return (
      <EmptyState
        title="Automação não encontrada"
        description="Ela pode ter sido apagada."
        action={
          <Button asChild variant="secondary">
            <Link to={`/${workspace}/automations`}>Voltar para a lista</Link>
          </Button>
        }
      />
    )
  return <LoadedEditor key={id} data={q.data} workspace={workspace} desktop={desktop} />
}

/** O mapa da automação como editor de conteúdo de outra tela (a transmissão). */
export function FlowMap({ workspace, host }: { workspace: string; host: FlowHost }) {
  const own = !host.tags
  const tags = useAsync(() => own ? listTags(workspace) : Promise.resolve(null), `flow-map-tags:${workspace}:${own ? "api" : "host"}`)
  const stub = React.useMemo(() => ({ id: "flow-map", name: host.label, status: "draft", draft_graph: host.graph, published_version_id: null, has_unpublished_changes: false, locked: false }) as unknown as Automation, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [automation, setAutomation] = React.useState(stub)
  const [triggers, setTriggers] = React.useState<Trigger[]>([])
  if (own && tags.error) return <Banner variant="danger"><span className="mr-3">Não consegui abrir o mapa.</span><Button size="sm" variant="secondary" onClick={tags.reload}>Tentar de novo</Button></Banner>
  if (own && tags.loading) return <Skeleton aria-label="Carregando mapa" className="h-full min-h-64 w-full" />
  return <ReactFlowProvider><FlowEditor data={{ automation, triggers, stats: host.stats ?? null, tags: host.tags ?? tags.data ?? [], published: null }} workspace={workspace} setAutomation={setAutomation} setTriggers={setTriggers} host={host} /></ReactFlowProvider>
}

function LoadedEditor({ data, workspace, desktop }: { data: Loaded; workspace: string; desktop: boolean }) {
  // O estado persistido acompanha a automação quando o editor troca de tamanho.
  const [automation, setAutomation] = React.useState(data.automation)
  const [triggers, setTriggers] = React.useState(data.triggers)
  const current = { ...data, automation, triggers }
  if (!desktop) return <MobileSteps data={current} workspace={workspace} setAutomation={setAutomation} />
  return (
    <ReactFlowProvider>
      <FlowEditor data={current} workspace={workspace} setAutomation={setAutomation} setTriggers={setTriggers} />
    </ReactFlowProvider>
  )
}

const PREFIX = stepIdPrefix

function FlowEditor({ data, workspace, setAutomation, setTriggers, host }: { data: Loaded; workspace: string; setAutomation: React.Dispatch<React.SetStateAction<Automation>>; setTriggers: React.Dispatch<React.SetStateAction<Trigger[]>>; host?: FlowHost }) {
  const { getNodes, getNodesBounds, getViewport, setViewport } = useReactFlow()
  const catalog = useAsync(async () => {
    const [fields, automations, sequences, members, connections, segments] = await Promise.allSettled([listEditorFields(workspace), listAutomations(workspace), listSequences(workspace), listActionMembers(), listConnections(workspace), listSegments()])
    return {
      members: members.status === "fulfilled" ? members.value : [],
      connections: connections.status === "fulfilled" ? connections.value : undefined,
      sequences: sequences.status === "fulfilled" ? sequences.value : [],
      fields: fields.status === "fulfilled" ? fields.value.filter(f => f.scope === "contact") : [],
      botFields: fields.status === "fulfilled" ? fields.value.filter(f => f.scope === "bot" && !("archived" in f && f.archived)) : [],
      automations: automations.status === "fulfilled" ? automations.value : [],
      segments: segments.status === "fulfilled" ? segments.value.filter(segment => !segment.error) : [],
      errors: { fields: fields.status === "rejected", automations: automations.status === "rejected", segments: segments.status === "rejected", sequences: sequences.status === "rejected", members: members.status === "rejected", connections: connections.status === "rejected" },
    }
  }, `editor-catalogs:${workspace}`)
  // Listas estáveis entre renderizações (o `?? []` solto criava uma lista nova a cada vez e refazia a validação).
  const { sequences, fields, botFields, automations, members, segments } = React.useMemo(() => ({
    sequences: catalog.data?.sequences ?? [], fields: catalog.data?.fields ?? [], botFields: catalog.data?.botFields ?? [],
    automations: catalog.data?.automations ?? [], members: catalog.data?.members ?? [], segments: catalog.data?.segments ?? [],
  }), [catalog.data])
  const connections = catalog.data?.connections
  const automation = data.automation
  const triggers = data.triggers
  // Fluxos antigos: o passo de mensagem sem canal recebe o do gatilho (ou fica "a escolher" com vários canais).
  // Automação publicada abre primeiro a versão publicada, só para ver; rascunho sem publicação abre direto em edição.
  const [initialGraph] = React.useState(() => host ? host.graph : data.automation.published_version_id !== null && data.published ? data.published : data.automation.draft_graph)
  // No hospedeiro, o passo de mensagem herda o canal da transmissão.
  const withHostChannel = (steps: FlowNode[]) => host?.channel ? steps.map(n => n.type === "message" && n.data.config.channel === undefined ? { ...n, data: { ...n.data, config: { ...n.data.config, channel: host.channel } } } : n) : steps
  const [nodes, setNodes] = React.useState<FlowNode[]>(() => withHostChannel(assignStepChannels(toFlow(initialGraph).nodes, data.triggers)))
  const [edges, setEdges] = React.useState<FlowEdge[]>(() => toFlow(initialGraph).edges)
  const [choosingChannel, setChoosingChannel] = React.useState<{ origin?: { id: string; port: string }; at?: { x: number; y: number } } | null>(null)
  // Conector solto no vazio do mapa: de onde saiu e onde caiu (tela, para a caixinha; mapa, para o passo novo).
  const [drop, setDrop] = React.useState<{ source: string; port: string; screen: { x: number; y: number }; flow: { x: number; y: number } } | null>(null)
  const [name, setName] = React.useState(data.automation.name)
  const [savedSnapshot, setSavedSnapshot] = React.useState(() => {
    const flow = toFlow(initialGraph)
    return graphSnapshot(assignStepChannels(flow.nodes, data.triggers), flow.edges)
  })
  const dirty = graphSnapshot(nodes, edges) !== savedSnapshot
  const [editing, setEditing] = React.useState(host?.readOnly ? false : data.automation.published_version_id === null)
  const [panelId, setPanelId] = React.useState<string | null>(null)
  const [triggerDialog, setTriggerDialog] = React.useState<string | null>(null)
  const [creating, setCreating] = React.useState<NewTriggerChoice | null>(null)
  const [pickedTrigger, setPickedTrigger] = React.useState<string | undefined>()
  // Construtor básico: os passos em lista, na ordem das ligações, com o mesmo painel de edição.
  // Editor novo (mapa) x clássico (lista de passos): a escolha fica lembrada neste navegador.
  const [listModeStored, setListModeState] = React.useState(() => { try { return localStorage.getItem("editor-mode") === "classic" } catch { return false } })
  const listMode = !host && listModeStored
  const setListMode = (next: boolean | ((m: boolean) => boolean)) => setListModeState(m => { const v = typeof next === "function" ? next(m) : next; try { localStorage.setItem("editor-mode", v ? "classic" : "new") } catch { /* sem armazenamento */ } return v })
  const [busy, setBusy] = React.useState<"save" | "publish" | "status" | null>(null)
  const [renaming, setRenaming] = React.useState(false)
  const [confirmDeletion, setConfirmDeletion] = React.useState(false)
  /** Gatilhos que acabaram de ser ligados mas ficam encobertos por outra regra acima: a janela mostra e oferece resolver. */
  const [shadowed, setShadowed] = React.useState<{ trigger: string; conflict: KeywordConflict; rowId?: string }[]>([])
  const [fixing, setFixing] = React.useState(false)
  const [showErrors, setShowErrors] = React.useState(false)
  const [pendingOpen, setPendingOpen] = React.useState(false)
  // A cada abertura a prévia recomeça do zero (a chave muda).
  const [preview, setPreview] = React.useState<number | null>(null)
  const [compatOpen, setCompatOpen] = React.useState(false)
  // "Mais métricas" e "Chamada por" saíram da lateral e vivem no menu ⋮; ligados, aparecem abaixo dos cartões.
  const [sideExtras, setSideExtras] = React.useState({ more: false, called: false })
  const [lockOpen, setLockOpen] = React.useState(false)
  const shareAutomation = async () => {
    try { const { token } = await apiRequest<{ token: string }>(`/automations/${encodeURIComponent(automation.id)}/share`, { method: "POST", body: "{}" }); const link = `${window.location.origin}/automacao-compartilhada/${token}`; await navigator.clipboard.writeText(link).catch(() => {}); toast.success(`Link copiado: ${link}`) }
    catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível gerar o link.") }
  }
  // O painel não sabe se há link ativo: a resposta do engine diz se algum foi desativado.
  const revokeShare = async () => {
    if (!window.confirm("Desativar o link compartilhado? Quem tiver o link não consegue mais abrir nem copiar esta automação.")) return
    try { const { revoked } = await revokeAutomationShare(automation.id); toast.success(revoked ? "Link desativado." : "Esta automação não tinha link ativo.") }
    catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível desativar o link.") }
  }

  const published = automation.published_version_id !== null
  const admin = useCan("team")
  // Travada pelo dono ou administrador: os demais papéis só leem.
  const canEdit = useCan("edit") && (admin || !lockedActionsOf(automation).includes("edit"))
  const readOnly = !canEdit || !editing
  const errors = React.useMemo(() => validateGraph(nodes, edges, triggers, { fields, botFields, segments, automations, sequences, members, connections, automationId: automation.id }), [nodes, edges, triggers, fields, botFields, segments, automations, sequences, members, connections, automation.id])
  const panelNode = nodes.find((n) => n.id === panelId)

  // Hospedeiro: cada mudança do fluxo volta para quem guarda o rascunho (a posição dos passos conta, o tamanho medido não).
  const emitted = React.useRef(host ? JSON.stringify(toGraph(nodes, edges)) : "")
  React.useEffect(() => {
    if (!host) return
    const graph = toGraph(nodes, edges), snapshot = JSON.stringify(graph)
    if (snapshot === emitted.current) return
    emitted.current = snapshot
    host.onChange(graph)
  }, [nodes, edges, host])

  React.useEffect(() => {
    if (!dirty || host) return
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", h)
    return () => window.removeEventListener("beforeunload", h)
  }, [dirty, host])

  // Desfazer/refazer, copiar/colar e duplicar (Ctrl ou Cmd). Mudanças seguidas em menos de 600 ms viram um passo só do histórico.
  const history = React.useRef(new History<{ nodes: FlowNode[]; edges: FlowEdge[] }>(s => graphSnapshot(s.nodes, s.edges)))
  const last = React.useRef({ nodes, edges, at: 0, applying: false })
  // A pilha mora num ref (não redesenha); os botões leem este estado, atualizado a cada gravação, desfazer ou refazer.
  const [historyState, setHistoryState] = React.useState({ canUndo: false, canRedo: false })
  const syncHistory = () => setHistoryState(prev => prev.canUndo === history.current.canUndo && prev.canRedo === history.current.canRedo ? prev : { canUndo: history.current.canUndo, canRedo: history.current.canRedo })
  React.useEffect(() => {
    const prev = last.current, now = Date.now()
    if (!prev.applying && now - prev.at > 600) history.current.record({ nodes: prev.nodes, edges: prev.edges }, { nodes, edges })
    last.current = { nodes, edges, at: prev.applying || graphSnapshot(prev.nodes, prev.edges) === graphSnapshot(nodes, edges) ? prev.at : now, applying: false }
    syncHistory()
  }, [nodes, edges])
  const applyHistory = (state: { nodes: FlowNode[]; edges: FlowEdge[] } | undefined) => {
    if (!state) return
    last.current = { ...last.current, applying: true }
    setNodes(state.nodes); setEdges(state.edges)
    syncHistory()
  }
  const undo = () => applyHistory(history.current.undo({ nodes, edges }))
  const redo = () => applyHistory(history.current.redo({ nodes, edges }))
  const keyActions = React.useRef<EditorKeyActions>({ undo: () => {}, redo: () => {}, removeElements: () => {} })
  const refCatalogs = React.useMemo(() => ({ tag: data.tags, field: [...fields, ...botFields], sequence: sequences }), [data.tags, fields, botFields, sequences])
  const pasteCatcher = useEditorClipboard({ readOnly, nodes, edges, setNodes, setEdges, triggers, catalogs: refCatalogs, keyActions })

  // "Editar automação": passa da versão publicada para o rascunho (que pode ter mudanças ainda não publicadas).
  function startEditing() {
    const flow = toFlow(automation.draft_graph)
    const steps = assignStepChannels(flow.nodes, triggers)
    if (!dirty && graphSnapshot(steps, flow.edges) !== savedSnapshot) {
      setNodes(steps); setEdges(flow.edges); setSavedSnapshot(graphSnapshot(steps, flow.edges))
      last.current = { nodes: steps, edges: flow.edges, at: 0, applying: true }
    }
    setEditing(true)
  }

  // Hospedeiro: o mapa abre inteiro na tela, alinhado ao topo e à esquerda como no original (sem centralizar nem passar do zoom 1).
  const fit = React.useCallback(() => {
    const box = canvasRef.current?.getBoundingClientRect(), all = getNodes()
    if (!box || all.length === 0) return
    void setViewport(mapViewport(box, all, getNodesBounds(all), host), { duration: 200 })
  }, [getNodes, getNodesBounds, setViewport, host])
  const refit = React.useCallback(() => {
    window.setTimeout(fit, 60)
  }, [fit])

  // O painel lateral sobrepõe o mapa: abrir ou fechar não mexe no zoom nem no lugar dos passos. Só quando o passo escolhido
  // ficaria todo escondido atrás do painel o mapa desliza na horizontal o mínimo para ele aparecer.
  const panelRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!panelId) return
    const timer = window.setTimeout(() => {
      const width = panelRef.current?.getBoundingClientRect().width ?? 0
      const target = getNodes().find(n => n.id === panelId)
      if (!target || width === 0) return
      const view = getViewport(), w = (target.measured?.width ?? target.width ?? 0) * view.zoom
      const left = target.position.x * view.zoom + view.x
      // Na transmissão o passo escolhido nunca fica nem em parte atrás do painel; no editor de automação só quando some por inteiro.
      if (host) {
        // Também desce o mapa se o passo ficou sob os seletores do topo: a barra flutuante do passo (acima dele) precisa de ~100 px livres.
        const top = target.position.y * view.zoom + view.y
        const x = left < width + 24 ? view.x + (width + 24 - left) : view.x, y = top < 112 ? view.y + (112 - top) : view.y
        if (x !== view.x || y !== view.y) void setViewport({ ...view, x, y }, { duration: 200 })
        return
      }
      if (left + w < width + 40) void setViewport({ ...view, x: view.x + (width + 24 - left) }, { duration: 200 })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [panelId, getNodes, getViewport, setViewport, host])

  // Enquadra quando os nós ganham tamanho medido; abrir ou fechar um painel não mexe no zoom do mapa.
  const nodesMeasured = useNodesInitialized()
  React.useEffect(() => {
    if (nodesMeasured) refit()
  }, [refit, nodesMeasured])

  // Entrar e sair da edição troca a lateral de métricas: o mapa muda de largura e se enquadra de novo.
  React.useEffect(() => { refit() }, [readOnly, refit])

  // Alturas reais (medidas): cartão alto não cobre o de baixo. Só na tela; o estado e o rascunho ficam como estão.
  const spaced = React.useMemo(() => separateByHeight(nodes), [nodes])
  const pushedDown = spaced !== nodes
  // Hospedeiro: o início do envio é um cartão fixo à esquerda do primeiro passo; só aparece na tela, nunca entra no fluxo guardado.
  const starts = host ? spaced.filter(n => !isAnnotation(n) && !edges.some(e => e.target === n.id)) : []
  const [startSize, setStartSize] = React.useState<{ width: number; height: number }>()
  // Fluxo sem nenhum passo além do gatilho (ou transmissão vazia): o cartão "Escolha o primeiro passo", ligado ao "Então"
  // (ou ao início do envio). Só na tela: não entra no estado dos passos, no grafo salvo, na validação nem no histórico.
  // Mapa estreito (celular): o cartão fica abaixo do início, com o conector descendo até o topo dele, para início e cartão
  // caberem juntos na largura em zoom de leitura; no mapa largo ele fica à direita.
  const [narrowMap, setNarrowMap] = React.useState(false)
  React.useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setNarrowMap(entry.contentRect.width > 0 && entry.contentRect.width < NARROW_MAP.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const trigger = host ? undefined : spaced.find(n => n.type === "trigger")
  const firstStepAt = readOnly || listMode || !needsFirstStep(nodes) || (!host && !trigger) ? null
    : trigger ? (narrowMap ? { x: trigger.position.x, y: trigger.position.y + (trigger.measured?.height ?? 260) + FIRST_STEP_GAP.below } : { x: trigger.position.x + FIRST_STEP_GAP.automation, y: trigger.position.y })
    : narrowMap ? { x: 0, y: (startSize?.height ?? 116) + FIRST_STEP_GAP.below } : { x: 0, y: 0 }
  const [firstStepSize, setFirstStepSize] = React.useState<{ width: number; height: number }>()
  const firstStepGroups = React.useMemo(() => stepCatalog({ triggers, connections, hostChannel: host?.channel }, "first-step"), [triggers, connections, host?.channel])
  const pickFirstStep = React.useRef<(item: DropItem) => void>(() => {})
  const onPickFirstStep = React.useCallback((item: DropItem) => pickFirstStep.current(item), [])
  const startNode = (position: { x: number; y: number }) => ({ id: BROADCAST_START_ID, type: "broadcast_start", position, data: { config: {} }, draggable: false, selectable: false, deletable: false, focusable: false, connectable: false, ...(startSize ? { measured: startSize } : {}) }) as FlowNode
  const shownNodes = React.useMemo(() => {
    if (firstStepAt) {
      const card = { id: FIRST_STEP_ID, type: "first_step", position: firstStepAt, data: { config: {}, groups: firstStepGroups, onPick: onPickFirstStep, vertical: narrowMap } satisfies FirstStepData, draggable: false, selectable: false, deletable: false, focusable: false, connectable: false, ...(firstStepSize ? { measured: firstStepSize } : {}) } as unknown as FlowNode
      return [...(host ? [startNode(narrowMap ? { x: 0, y: 0 } : { x: firstStepAt.x - FIRST_STEP_GAP.broadcast, y: firstStepAt.y })] : []), ...spaced, card]
    }
    return starts.length === 1 ? [startNode({ x: starts[0].position.x - 300, y: starts[0].position.y }), ...spaced] : spaced
  }, [spaced, starts.length === 1 ? starts[0].position.x : 0, starts.length === 1 ? starts[0].position.y : 0, starts.length, startSize, firstStepAt?.x, firstStepAt?.y, firstStepSize, firstStepGroups, narrowMap]) // eslint-disable-line react-hooks/exhaustive-deps
  const shownEdges = React.useMemo(() => {
    const fixed = { selectable: false, deletable: false, focusable: false }
    if (firstStepAt) return [host ? { id: "broadcast-start-edge", source: BROADCAST_START_ID, sourceHandle: "next", target: FIRST_STEP_ID, ...fixed } as FlowEdge : { id: "first-step-edge", source: trigger!.id, sourceHandle: PORT_THEN, target: FIRST_STEP_ID, ...fixed } as FlowEdge, ...edges]
    return starts.length === 1 ? [{ id: "broadcast-start-edge", source: BROADCAST_START_ID, sourceHandle: "next", target: starts[0].id, ...fixed } as FlowEdge, ...edges] : edges
  }, [edges, starts.length === 1 ? starts[0].id : "", !!firstStepAt, trigger?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (pushedDown && nodesMeasured) refit() }, [pushedDown, nodesMeasured, refit])
  // O cartão aparece ou some (passo criado, último passo apagado, entrar na edição): o mapa se enquadra quando ele já tem tamanho.
  const firstStepShown = !!firstStepAt && !!firstStepSize
  React.useEffect(() => { if (firstStepShown) refit() }, [firstStepShown, narrowMap, refit])
  // Com a caixinha aberta, o conector provisório vai da saída até o ponto da soltura (só na tela, fora do fluxo e do histórico).
  const mapNodes = React.useMemo(() => drop ? [...shownNodes, { id: DROP_ANCHOR_ID, type: "connect_drop", position: drop.flow, data: { config: {} }, draggable: false, selectable: false, deletable: false, focusable: false, connectable: false, measured: { width: 1, height: 1 } } as FlowNode] : shownNodes, [shownNodes, drop])
  const mapEdges = React.useMemo(() => drop ? [...shownEdges, { id: "connect-drop-edge", source: drop.source, sourceHandle: drop.port, target: DROP_ANCHOR_ID, selectable: false, deletable: false, focusable: false } as FlowEdge] : shownEdges, [shownEdges, drop])

  const onNodesChange = React.useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      // O cartão de início não está no estado dos passos: só o tamanho medido dele é guardado, senão o mapa o deixa invisível.
      for (const change of changes) if (change.type === "dimensions" && change.dimensions) {
        if (change.id === BROADCAST_START_ID) setStartSize(change.dimensions)
        else if (change.id === FIRST_STEP_ID) setFirstStepSize(change.dimensions)
      }
      setNodes((ns) => applyNodeChanges(changes, ns))
    },
    []
  )
  const onEdgesChange = React.useCallback((changes: EdgeChange<FlowEdge>[]) => {
    setEdges((es) => applyEdgeChanges(changes, es))
  }, [])

  const setLink = React.useCallback((from: string, port: string, to: string | null) => {
    setEdges((es) => {
      const rest = es.filter((e) => !(e.source === from && e.sourceHandle === port))
      return to ? [...rest, { id: edgeId(from, port), source: from, sourceHandle: port, target: to }] : rest
    })
  }, [])

  const onConnect = React.useCallback(
    (c: Connection) => {
      if (readOnly || !c.sourceHandle) return
      setLink(c.source, c.sourceHandle, c.target)
    },
    [readOnly, setLink]
  )

  const removeElements = React.useCallback((dn: FlowNode[], de: FlowEdge[]) => {
    setPanelId((p) => (p && dn.some((n) => n.id === p) ? null : p))
    const what = dn.length > 0 ? (dn.length === 1 ? (isAnnotation(dn[0]) ? `${nodeTitle[dn[0].type ?? ""]} ${dn[0].type === "frame" ? "removido" : "removida"}` : `Passo “${nodeTitle[dn[0].type ?? ""] ?? "passo"}” removido`) : dn.every(isAnnotation) ? `${dn.length} itens removidos` : removedSummary(dn)) : "Ligação removida"
    toast(what, {
      action: {
        label: "Desfazer",
        onClick: () => {
          setNodes((ns) => [...ns, ...dn.filter((n) => !ns.some((x) => x.id === n.id)).map((n) => ({ ...n, selected: false }))])
          setEdges((es) => [...es, ...de.filter((e) => !es.some((x) => x.id === e.id)).map((e) => ({ ...e, selected: false }))])
        },
      },
    })
  }, [])
  // Atalhos do teclado chamam sempre a versão atual (o ouvinte não é refeito a cada desfazer/refazer).
  keyActions.current = { undo, redo, removeElements }

  const deleteNode = React.useCallback(
    (nid: string) => {
      const dn = nodes.filter((n) => n.id === nid && n.type !== "trigger")
      if (dn.length === 0) return
      const de = edges.filter((e) => e.source === nid || e.target === nid)
      setNodes((ns) => ns.filter((n) => n.id !== nid))
      setEdges((es) => es.filter((e) => e.source !== nid && e.target !== nid))
      removeElements(dn, de)
    },
    [nodes, edges, removeElements]
  )

  const closePanel = React.useCallback(() => {
    setPanelId(null)
    setCreating(null)
    setNodes((ns) => (ns.some((n) => n.selected) ? ns.map((n) => (n.selected ? { ...n, selected: false } : n)) : ns))
  }, [])

  const onSelectionChange = React.useCallback(({ nodes: sel }: OnSelectionChangeParams) => {
    if (sel.length === 1) setPanelId(sel[0].id)
  }, [])

  const updateConfig = React.useCallback((nid: string, patch: Record<string, unknown>) => {
    setNodes((ns) => ns.map((n) => {
      if (n.id !== nid) return n
      const config = { ...n.data.config, ...patch }
      const next = { ...n, data: { ...n.data, config } }
      return isAnnotation(n) ? { ...next, ariaLabel: annotationAriaLabel(n.type === "frame" ? "group" : "note", String(n.type === "frame" ? config.title ?? "" : config.text ?? "")) } : { ...next, ariaLabel: stepAriaLabel(n.type ?? "", config) }
    }))
  }, [])

  function addNode(type: EditableNodeType, origin?: { id: string; port: string }, at?: { x: number; y: number }, channel?: StepChannel | typeof PENDING_CHANNEL) {
    if (type === "message" && !channel && host?.channel) channel = host.channel
    // Mensagem pertence a um canal. Só pergunta quando não dá para saber: herda do passo de origem, senão do único canal dos gatilhos ou do único canal ligado.
    if (type === "message" && !channel) {
      const known = inferredStepChannel(origin && nodes.find(n => n.id === origin.id)?.data.config, triggers, connections)
      if (!known) { setChoosingChannel({ origin, at }); return }
      channel = known
    }
    const nid = newId(PREFIX[type], nodes.map((n) => n.id))
    const sourceFree = (n: FlowNode): string | null => {
      return outputPorts(n).map(p => p.port).find(port => !edges.some(e => e.source === n.id && e.sourceHandle === port)) ?? null
    }
    const sel = nodes.find((n) => n.id === panelId)
    const steps = nodes.filter(n => !isAnnotation(n))
    const leaf = [...steps].sort((a, b) => b.position.x - a.position.x).find((n) => sourceFree(n))
    const src = origin ? nodes.find(n => n.id === origin.id) : sel && sourceFree(sel) ? sel : leaf
    const port = origin?.port ?? (src ? sourceFree(src) : null)
    let pos = at ?? (src ? { x: src.position.x + 360, y: src.position.y } : { x: 0, y: 80 })
    while (steps.some((n) => Math.abs(n.position.x - pos.x) < 40 && Math.abs(n.position.y - pos.y) < 120)) pos = { ...pos, y: pos.y + 220 }
    const node: FlowNode = {
      id: nid,
      type,
      position: pos,
      data: { config: { ...defaultConfig(type), ...(channel ? { channel } : {}), label: creationTitle(type, typeof navigator === "undefined" ? "pt" : navigator.language) } },
      deletable: true,
      selected: true,
      ariaLabel: stepAriaLabel(type, defaultConfig(type)),
    }
    setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), node])
    // Liga à saída quando há origem (inclusive o conector solto no vazio, que traz origem e ponto); duplo clique no vazio cria solto.
    if ((origin || !at) && src && port) setEdges((es) => [...es.filter(e => !(e.source === src.id && e.sourceHandle === port)), { id: edgeId(src.id, port), source: src.id, sourceHandle: port, target: nid }])
    setPanelId(nid)
    // Conector solto no vazio: o passo fica onde a pessoa soltou, sem reenquadrar o mapa.
    if (!(origin && at)) refit()
  }

  // "Gatilho" do menu do "+": abre o passo do gatilho, onde ficam os gatilhos e o "Novo gatilho".
  const openTrigger = () => {
    const trigger = nodes.find(n => n.type === "trigger")
    if (!trigger) return
    setNodes(ns => ns.map(n => n.selected !== (n.id === trigger.id) ? { ...n, selected: n.id === trigger.id } : n))
    setPanelId(trigger.id)
  }

  const canvasRef = React.useRef<HTMLDivElement>(null)
  const groupDrag = React.useRef<GroupDrag | null>(null)
  const { screenToFlowPosition } = useReactFlow()

  // Conector solto no vazio do mapa (não num passo): abre a caixinha de próximos passos no ponto da soltura.
  // Soltar numa entrada continua ligando por onConnect.
  const onConnectEnd = React.useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (readOnly || !state.fromNode || !state.fromHandle?.id || state.fromNode.id === BROADCAST_START_ID) return
    const p = "changedTouches" in event ? event.changedTouches[0] : event
    if (!p) return
    const overNode = !!document.elementFromPoint(p.clientX, p.clientY)?.closest(".react-flow__node")
    if (!opensDropMenu(state, overNode)) return
    setDrop({ source: state.fromNode.id, port: state.fromHandle.id, screen: { x: p.clientX, y: p.clientY }, flow: screenToFlowPosition({ x: p.clientX, y: p.clientY }) })
  }, [readOnly, screenToFlowPosition])
  const pickDrop = (item: DropItem) => {
    const at = drop
    setDrop(null)
    if (at) addNode(item.type, { id: at.source, port: at.port }, dropStepPosition(at.flow), item.channel)
  }
  // Cartão do primeiro passo: o passo nasce no lugar do cartão, ligado ao "Então" (na transmissão o início do envio liga sozinho).
  pickFirstStep.current = (item: DropItem) => {
    if (!firstStepAt) return
    addNode(item.type, trigger ? { id: trigger.id, port: PORT_THEN } : undefined, firstStepAt, item.channel)
    // No mapa estreito o passo nasce abaixo do início; o mapa se enquadra de novo (o início volta para a esquerda do passo).
    if (narrowMap) refit()
  }

  async function addAnnotation(kind: AnnotationKind) {
    const author = kind === "note" ? (await getWorkspace().catch(() => null))?.user_name : undefined
    const { x, y, zoom } = getViewport()
    const box = canvasRef.current?.getBoundingClientRect()
    const size = clampSize(kind, { w: Number.NaN, h: Number.NaN })
    const center = { x: (-x + (box?.width ?? 800) / 2) / zoom - size.w / 2, y: (-y + (box?.height ?? 500) / 2) / zoom - size.h / 2 }
    const node = createAnnotation(kind, nodes, center, author)
    setNodes((ns) => {
      const cleared = ns.map((n) => (n.selected ? { ...n, selected: false } : n))
      // Grupo fica atrás dos passos; nota fica na frente.
      return kind === "group" ? [{ ...node, selected: true }, ...cleared] : [...cleared, { ...node, selected: true }]
    })
    setPanelId(node.id)
  }

  const resizeAnnotation = React.useCallback((nid: string, size: { w: number; h: number }) => {
    setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, width: size.w, height: size.h } : n)))
  }, [])

  async function persist() {
    const g = toGraph(nodes, edges)
    await saveDraft(automation.id, g)
    setAutomation((a) => ({ ...a, draft_graph: g, has_unpublished_changes: a.published_version_id !== null }))
    setSavedSnapshot(graphSnapshot(nodes, edges))
  }

  async function onSave() {
    setBusy("save")
    try {
      await persist()
      toast.success("Rascunho salvo")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar.")
    } finally {
      setBusy(null)
    }
  }

  const [publishAfterTrigger, setPublishAfterTrigger] = React.useState<{ confirmed: boolean } | null>(null)
  const publishRef = React.useRef(onPublish)
  publishRef.current = onPublish
  React.useEffect(() => {
    if (!publishAfterTrigger || creating) return
    setPublishAfterTrigger(null)
    void publishRef.current(publishAfterTrigger.confirmed)
  }, [publishAfterTrigger, creating])

  async function onPublish(confirmed = false) {
    // Painel "Novo gatilho" aberto: cria o gatilho antes de publicar; incompleto, avisa em vez de ignorar.
    const draftTrigger = creating ? getPendingTrigger() : null
    if (draftTrigger) {
      if (draftTrigger.missing) {
        toast.error(`O novo gatilho ainda não foi criado. ${draftTrigger.missing} Complete ou cancele antes de publicar.`)
        return
      }
      setBusy("publish")
      const ok = await draftTrigger.submit().finally(() => setBusy(null))
      if (!ok) { toast.error("Não consegui criar o gatilho; a automação não foi publicada."); return }
      // Publica no próximo render, já com o gatilho novo na lista (a validação depende dele).
      setPublishAfterTrigger({ confirmed })
      return
    }
    const bad = Object.keys(errors)
    if (bad.length > 0) {
      setShowErrors(true)
      setPanelId(bad[0])
      setPendingOpen(true)
      return
    }
    if (!confirmed && nodes.some(n => (n.type === "action" || n.type === "action_group") && getActions(n.data.config).some(a => a.type === "delete_subscriber"))) {
      setConfirmDeletion(true)
      return
    }
    setBusy("publish")
    try {
      await persist()
      const firstPublish = automation.published_version_id === null
      const v = await publishAutomation(automation.id)
      const fresh = await getAutomation(workspace, automation.id)
      if (fresh) setAutomation(fresh.automation)
      if (!host) await afterPublish(firstPublish)
      setConfirmDeletion(false)
      setEditing(false)
      setShowErrors(false)
      setPendingOpen(false)
      closePanel()
      toast.success(`Publicada · versão ${v.version}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui publicar.")
    } finally {
      setBusy(null)
    }
  }

  /** Publicar liga o gatilho que nunca foi ligado (Inicial) e, na primeira publicação, também o que nasceu desligado.
   * Quem desligou o gatilho depois de publicar continua com ele desligado. Depois avisa se outra palavra-chave responde antes. */
  async function afterPublish(firstPublish: boolean) {
    const stateOf = (t: Trigger) => t.state ?? (t.active ? "active" : "draft")
    const enabled: Trigger[] = []
    for (const t of triggers.filter(t => stateOf(t) === "initial" || (firstPublish && stateOf(t) === "draft"))) {
      try { enabled.push(await setExternalTriggerState(automation.id, t, "active")) }
      catch (e) { toast.error(`Publicada, mas não consegui ligar o gatilho “${t.name}”: ${e instanceof Error ? e.message : "erro desconhecido"} Ligue pelo painel do gatilho.`) }
    }
    const current = triggers.map(t => enabled.find(x => x.id === t.id) ?? t)
    if (enabled.length) {
      setTriggers(ts => ts.map(t => enabled.find(x => x.id === t.id) ?? t))
      toast.success(enabled.length === 1 ? `Gatilho “${enabled[0].name}” ligado.` : `${enabled.length} gatilhos ligados.`)
    }
    const keywordTriggers = current.filter(t => t.type === "dm_keyword" && t.active)
    if (!keywordTriggers.length) return
    try {
      const rows = await listKeywords(workspace)
      const found: { trigger: string; conflict: KeywordConflict; rowId?: string }[] = []
      for (const t of keywordTriggers) for (const k of t.keywords ?? []) {
        if (k.parent_id || k.rule === "group") continue
        const c = findKeywordConflicts({ id: k.id, name: t.name, channel: t.channel_type ?? "", active: true, audience: t.audience === "group" ? "group" : "direct",
          connection_id: t.channel_id ?? null, case_sensitive: !!k.case_sensitive, rules: [{ condition: conditionFromEngineRule[k.rule] ?? "contains", words: k.words }] }, rows).find(x => x.otherWins)
        const rowId = rows.find(r => r.id === k.id)?.id ?? rows.find(r => r.automation_id === automation.id)?.id
        if (c && !found.some(f => f.conflict.other.id === c.other.id)) found.push({ trigger: t.name, conflict: c, rowId })
      }
      setShadowed(found)
    } catch { /* o aviso de conflito é só ajuda; a publicação já deu certo */ }
  }

  async function commitName() {
    const n = name.trim()
    if (!n) return setName(automation.name)
    if (n === automation.name) return
    setRenaming(true)
    try {
      const a = await renameAutomation(automation.id, n)
      setAutomation((cur) => ({ ...cur, name: a.name, updated_at: a.updated_at }))
      setName(a.name)
    } catch (e) {
      setName(automation.name)
      toast.error(e instanceof Error ? e.message : "Não consegui renomear.")
    } finally { setRenaming(false) }
  }

  async function changeStatus() {
    setBusy("status")
    try {
      const a = await setAutomationStatus(automation.id, automation.status === "stopped" ? "live" : "stopped")
      setAutomation(cur => ({ ...cur, status: a.status, updated_at: a.updated_at }))
      toast.success(a.status === "stopped" ? "Automação pausada" : "Automação retomada")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui mudar o status.")
    } finally { setBusy(null) }
  }

  // Só lido nos toques do celular simulado: com a prévia fechada nem monta o grafo.
  const previewEnv = preview === null ? null : { graph: toGraph(nodes, edges), catalog: { tags: data.tags, fields, sequences, automations } }

  const duplicateStep = React.useCallback((nid: string) => {
    const copied = copySelection(nodes.map(n => ({ ...n, selected: n.id === nid })), edges)
    if (!copied) return
    const next = pasteClip(copied, nodes, edges)
    setNodes(next.nodes); setEdges(next.edges)
    const pasted = next.nodes.find(n => n.selected)
    if (pasted) setPanelId(pasted.id)
  }, [nodes, edges])

  const newTrigger = React.useCallback((nodeId: string) => setTriggerDialog(nodeId), [])
  const pickTrigger = React.useCallback((triggerId: string) => { setCreating(null); setPickedTrigger(triggerId) }, [])
  const ctx = React.useMemo(
    () => ({ readOnly, fullMetrics: !host, stats: data.stats, triggers, tags: data.tags, fields, botFields, segments, automations, sequences, errors, showErrors, duplicateStep, deleteStep: deleteNode, newTrigger, pickTrigger }),
    [readOnly, host, data.stats, triggers, data.tags, fields, botFields, segments, automations, sequences, errors, showErrors, duplicateStep, deleteNode, newTrigger, pickTrigger]
  )

  const edgeDefaults = React.useMemo(
    () => ({ markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-border-input)" } }),
    []
  )

  return (
    <EditorProvider value={ctx}>
      <NewTriggerDialog open={triggerDialog !== null} onOpenChange={open => { if (!open) setTriggerDialog(null) }}
        onChoose={choice => { const nodeId = triggerDialog; setCreating(choice); if (nodeId) { setPanelId(nodeId); setNodes(ns => ns.map(n => ({ ...n, selected: n.id === nodeId }))) } }} />
      <Dialog open={shadowed.length > 0} onOpenChange={open => { if (!open && !fixing) setShadowed([]) }}>
        <DialogContent data-testid="publish-shadowed">
          <DialogHeader>
            <DialogTitle>Publicada, mas outra regra responde antes</DialogTitle>
            <DialogDescription>Enquanto isso não mudar, esta automação não vai responder a estas mensagens.</DialogDescription>
          </DialogHeader>
          {shadowed[0] ? (() => { const s = shadowed[0]; const fix = async (run: () => Promise<unknown>, ok: string, raised = false) => {
              setFixing(true)
              // Subir esta para o topo resolve todos os avisos da mesma regra de uma vez.
              try { await run(); toast.success(ok); setShadowed(list => raised ? list.filter(x => x.rowId !== s.rowId) : list.slice(1)) }
              catch (e) { toast.error(e instanceof Error ? e.message : "Não consegui mudar a regra.") }
              finally { setFixing(false) } }
            return <>
              <p className="break-words text-sm">{conflictMessage(s.conflict)}</p>
              <DialogFooter className="flex-col sm:flex-row">
                <Button variant="ghost" disabled={fixing} onClick={() => setShadowed(list => list.slice(1))}>Manter assim</Button>
                <Button variant="secondary" disabled={fixing} onClick={() => fix(() => setKeywordActive(workspace, s.conflict.other.id, false), `Regra “${s.conflict.other.name}” pausada.`)}>Pausar a outra</Button>
                {s.rowId ? <Button disabled={fixing} onClick={() => fix(() => moveKeyword(workspace, s.rowId!, 0), "Esta regra subiu para o topo.", true)}>Subir esta para o topo</Button> : null}
              </DialogFooter>
            </> })() : null}
        </DialogContent>
      </Dialog>
      <Dialog open={confirmDeletion} onOpenChange={open => { if (!busy) setConfirmDeletion(open) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publicar com exclusão de contato</DialogTitle>
            <DialogDescription>Esta automação poderá excluir os dados do contato e encerrar suas execuções. Essa exclusão não pode ser desfeita. Revise o caminho antes de publicar.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row">
            <Button variant="secondary" disabled={busy !== null} onClick={() => setConfirmDeletion(false)}>Voltar à edição</Button>
            <Button variant="danger" disabled={busy !== null} loading={busy === "publish"} onClick={() => onPublish(true)}>Publicar e permitir exclusão</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className={host ? "flex h-full min-h-0 flex-col" : "flex h-dvh min-h-128 flex-col"}>
        {/* Barra única do topo: migalha com o nome editável e a situação; à direita, o estado do rascunho e as ações. */}
        {host ? null : <header className="flex min-h-(--header) shrink-0 flex-wrap items-center lg:flex-nowrap gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-2">
          <nav aria-label="Você está em" className="flex min-w-0 items-center gap-1 text-sm">
            <Link
              to={`/${workspace}/automations`}
              aria-label="Voltar para a lista de automações"
              className="rounded-md px-1 text-text-muted hover:text-text"
            >
              Automações
            </Link>
            <ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
          </nav>
          <Input
            aria-label="Nome da automação"
            title={name}
            value={name}
            maxLength={100}
            disabled={renaming || !canEdit}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="-ml-2 h-9 max-w-md min-w-32 w-auto truncate field-sizing-content border-transparent bg-transparent text-base hover:border-border-input"
          />
          <Pencil className="-ml-2 size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
          <StatusBadge status={automation.status} />
          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
            {!readOnly ? (
              <>
                {dirty ? (
                  <>
                    <span role="status" className="flex items-center gap-2 text-xs text-warning">
                      <span aria-hidden="true" className="size-2 rounded-pill bg-warning" />
                      Alterações não salvas
                    </span>
                    <Button variant="secondary" onClick={onSave} loading={busy === "save"} disabled={busy !== null}>
                      Salvar rascunho
                    </Button>
                  </>
                ) : (
                  <span role="status" className="flex items-center gap-1 text-sm text-text-muted">
                    <Check className="size-4" aria-hidden="true" />
                    Salvo
                  </span>
                )}
                <Button variant="ghost" size="sm" aria-label="Desfazer" title="Desfazer (Ctrl+Z)" disabled={!historyState.canUndo} onClick={undo} className="px-2"><Undo2 className="size-4" aria-hidden="true" /></Button>
                <Button variant="ghost" size="sm" aria-label="Refazer" title="Refazer (Ctrl+Shift+Z)" disabled={!historyState.canRedo} onClick={redo} className="px-2"><Redo2 className="size-4" aria-hidden="true" /></Button>
              </>
            ) : null}
            {admin ? <LockMenu automation={automation} open={lockOpen} setOpen={setLockOpen} onChange={(locked, actions) => setAutomation(a => ({ ...a, locked, locked_actions: locked ? JSON.stringify(actions) : null }))} />
              : automation.locked ? <span role="status" className="flex items-center gap-1 text-xs text-text-muted"><Lock className="size-4" aria-hidden="true" />Travada pelo dono</span> : null}
            {admin && automation.locked ? <span role="status" className="flex items-center gap-1 text-xs text-text-muted"><Lock className="size-4" aria-hidden="true" />Travada</span> : null}
            <ChannelCompatibility open={compatOpen} onOpenChange={setCompatOpen} />
            <Button variant="secondary" aria-pressed={preview !== null} onClick={() => setPreview(p => p === null ? Date.now() : null)}>
              <Smartphone className="size-4" aria-hidden="true" />
              Prévia
            </Button>
            {!canEdit ? null : readOnly ? (
              <Button variant="secondary" onClick={startEditing}>
                <Pencil className="size-4" aria-hidden="true" />
                Editar automação
              </Button>
            ) : (
              <Button onClick={() => onPublish()} loading={busy === "publish"} disabled={busy !== null}>
                Publicar
              </Button>
            )}
            {/* Ações menos usadas ficam no menu, para o nome da automação caber na barra. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" aria-label="Mais ações da automação" className="px-2">
                  <EllipsisVertical className="size-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {published && canEdit ? <DropdownMenuItem disabled={busy !== null} onSelect={() => void changeStatus()}>{automation.status === "stopped" ? <Play className="size-4" aria-hidden="true" /> : <Pause className="size-4" aria-hidden="true" />}{automation.status === "stopped" ? "Retomar automação" : "Pausar automação"}</DropdownMenuItem> : null}
                {canEdit ? <DropdownMenuItem onSelect={() => void shareAutomation()}><Share2 className="size-4" aria-hidden="true" />Compartilhar</DropdownMenuItem> : null}
                {canEdit ? <DropdownMenuItem onSelect={() => void revokeShare()}><Link2Off className="size-4" aria-hidden="true" />Desativar link</DropdownMenuItem> : null}
                {readOnly && !host && preview === null ? <>
                  <DropdownMenuItem onSelect={() => setSideExtras(x => ({ ...x, more: !x.more }))}><Activity className="size-4" aria-hidden="true" />{sideExtras.more ? "Ocultar mais métricas" : "Mais métricas"}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setSideExtras(x => ({ ...x, called: !x.called }))}><Workflow className="size-4" aria-hidden="true" />{sideExtras.called ? "Ocultar chamada por" : "Chamada por"}</DropdownMenuItem>
                </> : null}
                <DropdownMenuItem onSelect={() => setListMode(m => !m)}><ListTree className="size-4" aria-hidden="true" />{listMode ? "Editor novo (mapa)" : "Editor clássico (lista)"}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setCompatOpen(true)}><Grid3x3 className="size-4" aria-hidden="true" />Compatibilidade por canal</DropdownMenuItem>
                {admin ? <DropdownMenuItem onSelect={() => setLockOpen(true)}>{automation.locked ? <Lock className="size-4" aria-hidden="true" /> : <LockOpen className="size-4" aria-hidden="true" />}{automation.locked ? "Permissões da trava" : "Travar"}</DropdownMenuItem> : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>}

        <div className="relative flex min-h-0 flex-1 [&>section]:rounded-none [&>section]:border-0 md:[&>section]:border-r [&>aside]:rounded-none [&>aside]:border-0 md:[&>aside]:border-r">
          {readOnly && !host && preview === null ? <TriggerMetrics automationId={automation.id} triggers={triggers} workspace={workspace} showMore={sideExtras.more} showCalled={sideExtras.called} /> : null}
          {/* O painel do passo sobrepõe o mapa (como no original): o mapa não muda de largura, de zoom nem de lugar ao abrir ou fechar. */}
          {panelNode ? <div ref={panelRef} className={`absolute bottom-0 left-0 z-30 flex w-full ${host ? "top-0 md:top-16" : "top-0"} max-w-full md:w-auto [&>section]:rounded-none [&>section]:border-0 md:[&>section]:border-r [&>aside]:rounded-none [&>aside]:border-0 md:[&>aside]:border-r`}>
          {isAnnotation(panelNode) ? (
            <AnnotationPanel
              key={panelNode.id}
              node={panelNode}
              readOnly={readOnly}
              update={(p) => updateConfig(panelNode.id, p)}
              resize={(size) => resizeAnnotation(panelNode.id, size)}
              onClose={closePanel}
              onDelete={() => deleteNode(panelNode.id)}
            />
          ) : (
            <PanelHost
              key={panelNode.id}
              node={panelNode}
              nodes={nodes.filter(n => !isAnnotation(n))}
              edges={edges}
              triggers={triggers}
              tags={data.tags}
              sequences={sequences}
              members={members}
              connections={connections}
              fields={fields}
              botFields={botFields}
              segments={segments}
              automations={automations}
              automationId={automation.id}
              published={published}
              catalogLoading={catalog.loading}
              catalogErrors={catalog.error ? { fields: true, automations: true, segments: true, sequences: true, members: true, connections: true } : catalog.data?.errors}
              reloadCatalogs={catalog.reload}
              readOnly={readOnly}
              errors={errors[panelNode.id] ?? []}
              showErrors={showErrors}
              updateConfig={(p) => updateConfig(panelNode.id, p)}
              setLink={(port, to) => setLink(panelNode.id, port, to)}
              createStep={(port, type) => addNode(type, { id: panelNode.id, port })}
              onClose={closePanel}
              onDeleteNode={() => deleteNode(panelNode.id)}
              dirty={dirty}
              triggerId={pickedTrigger}
              creating={creating}
              onCreated={() => setCreating(null)}
              onTriggerRemove={(id) => setTriggers((ts) => ts.filter((x) => x.id !== id))}
              onTriggerChange={(t) => setTriggers((ts) => ts.some(x => x.id === t.id) ? ts.map((x) => (x.id === t.id ? t : x)) : [...ts, t])}
            />
          )}
          </div> : null}
          <div ref={canvasRef} className="relative min-w-0 flex-1 overflow-hidden">
            {/* Aviso flutua no topo do mapa, sem empurrar o canvas para baixo. */}
            {!host && (!canEdit || readOnly) ? (
              <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4">
                <div className="pointer-events-auto">
                  {!canEdit ? (
                    <Banner variant="info">Seu papel permite ver esta automação, não alterar.</Banner>
                  ) : (
                    <Banner variant="warning">
                      Você está vendo a versão publicada ·{" "}
                      <button type="button" onClick={startEditing} className="font-semibold underline underline-offset-2">
                        Editar
                      </button>
                    </Banner>
                  )}
                </div>
              </div>
            ) : null}
            {pendingOpen && showErrors ? <PendingList items={pendingSteps(nodes, errors)} onPick={setPanelId} onClose={() => setPendingOpen(false)} /> : null}
            {listMode ? <StepList nodes={nodes} edges={edges} selected={panelId} onPick={setPanelId} /> : null}
            <textarea ref={pasteCatcher} aria-hidden="true" tabIndex={-1} value="" onChange={() => undefined} className="pointer-events-none fixed top-0 left-0 size-px opacity-0" data-testid="paste-catcher" />
            <ReactFlow
              style={listMode ? { display: "none" } : undefined}
              className="flow-canvas"
              nodes={mapNodes}
              edges={mapEdges}
              nodeTypes={mapNodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              onDelete={({ nodes: dn, edges: de }) => removeElements(dn as FlowNode[], de as FlowEdge[])}
              onSelectionChange={onSelectionChange}
              onKeyDown={(e) => {
                // Passo só focado (Tab), ainda não selecionado: o React Flow não apaga sozinho.
                if (readOnly || (e.key !== "Delete" && e.key !== "Backspace")) return
                const el = e.target as HTMLElement
                if (!el.classList.contains("react-flow__node")) return
                const nid = el.getAttribute("data-id")
                const n = nodes.find((x) => x.id === nid)
                if (n && !n.selected) deleteNode(n.id)
              }}
              onNodeClick={(_, n) => { if (n.id !== BROADCAST_START_ID && n.id !== FIRST_STEP_ID) setPanelId(n.id) }}
              onNodeDragStart={(e, n) => {
                groupDrag.current = n.type === "frame" ? startGroupDrag(n as FlowNode, nodes) : null
                // Alt+arrastar: deixa uma cópia no lugar (o gatilho não se duplica).
                if (e.altKey && !readOnly && n.type !== "trigger" && !isAnnotation(n as FlowNode)) {
                  const copy = { ...(n as FlowNode), id: newId(PREFIX[n.type as EditableNodeType] ?? "n", nodes.map(x => x.id)), selected: false, dragging: false, data: structuredClone((n as FlowNode).data) }
                  setNodes(ns => [...ns, copy])
                }
              }}
              zoomOnDoubleClick={false}
              onPaneClick={(e) => { if (e.detail === 2 && !readOnly) addNode("message", undefined, screenToFlowPosition({ x: e.clientX, y: e.clientY })) }}
              onNodeDrag={(_, n) => { const drag = groupDrag.current; if (drag && drag.id === n.id) setNodes((ns) => dragGroup(ns, drag, n.position)) }}
              onNodeDragStop={() => { groupDrag.current = null }}
              elevateNodesOnSelect={false}
              isValidConnection={(c) => c.source !== c.target}
              defaultEdgeOptions={edgeDefaults}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              edgesFocusable={!readOnly}
              deleteKeyCode={readOnly ? null : ["Delete", "Backspace"]}
              fitView={!host}
              fitViewOptions={FIT_OPTIONS}
              minZoom={0.3}
              ariaLabelConfig={ariaLabels}
              aria-label={host ? host.label : "Mapa da automação"}
            >
              <Background variant={BackgroundVariant.Dots} color="var(--color-border)" gap={20} />
              <Controls showInteractive={false} position="center-right" className="flow-zoom">
                {readOnly ? null : <>
                <ControlButton title="Organizar o mapa" aria-label="Organizar o mapa" onClick={() => { setNodes(ns => autoLayout(ns, edges, { x: 360, y: 260 }, n => isAnnotation(n))); refit() }}>
                  <LayoutGrid className="size-4" aria-hidden="true" />
                </ControlButton>
                {/* Notas, grupos e portais ficam na barra de zoom (no original o menu do + só tem passos). */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <ControlButton title="Notas e grupos" aria-label="Notas e grupos"><StickyNote className="size-4" aria-hidden="true" /></ControlButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="left" align="end" className="w-64 p-2">
                    <StepItem icon={StickyNote} onSelect={() => addAnnotation("note")}>{annotationLabels.note} adesiva</StepItem>
                    <StepItem icon={Group} onSelect={() => addAnnotation("group")}>{annotationLabels.group} de passos</StepItem>
                    <StepItem icon={Link2} onSelect={() => addAnnotation("portal")}>{annotationLabels.portal} para outro passo</StepItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                </>}
              </Controls>
              {readOnly ? null : (
                <Panel position="top-right" className="mt-14!">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button aria-label="Adicionar passo" title="Adicionar passo" className="size-12 rounded-pill p-0 shadow-pop">
                        <Plus className="size-6" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="max-h-[calc(100dvh-7rem)] w-104 overflow-y-auto p-5">
                      {host ? null : <>
                        <DropdownMenuLabel className="px-0 pb-3 text-sm font-semibold text-text">Passo inicial</DropdownMenuLabel>
                        <div className="grid grid-cols-2 gap-2"><StepItem icon={Zap} onSelect={openTrigger}>Gatilho</StepItem></div>
                      </>}
                      <DropdownMenuLabel className={host ? "px-0 pb-3 text-sm font-semibold text-text" : "px-0 pt-6 pb-3 text-sm font-semibold text-text"}>Conteúdo</DropdownMenuLabel>
                      <div className="grid grid-cols-2 gap-2">
                        {(host ? [] : availableStepChannels(connections)).map(channel => <StepItem key={channel} icon={channelGlyphs[channel]} onSelect={() => addNode("message", undefined, undefined, channel)}>{stepChannelLabels[channel]}</StepItem>)}
                        <StepItem icon={MessageSquare} onSelect={() => addNode("message")}>Mensagem</StepItem>
                        <StepItem icon={CircleHelp} onSelect={() => addNode("question")}>Pergunta</StepItem>
                        <StepItem icon={FileText} onSelect={() => addNode("template_message")}>Modelo (fora da janela)</StepItem>
                        <StepItem icon={Braces} onSelect={() => addNode("dynamic")}>Bloco dinâmico</StepItem>
                      </div>
                      <DropdownMenuLabel className="px-0 pt-6 pb-3 text-sm font-semibold text-text">Lógica</DropdownMenuLabel>
                      <div className="grid grid-cols-2 gap-2">
                        <StepItem icon={Tags} onSelect={() => addNode("action")}>Ações</StepItem>
                        <StepItem icon={GitBranch} onSelect={() => addNode("condition")}>Condição</StepItem>
                        <StepItem icon={Clock} onSelect={() => addNode("smart_delay")}>Esperar</StepItem>
                        <StepItem icon={Workflow} onSelect={() => addNode("start_automation")}>Iniciar automação</StepItem>
                        <StepItem icon={Shuffle} onSelect={() => addNode("randomizer")}>Dividir caminhos</StepItem>
                      </div>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </Panel>
              )}
              {readOnly ? null : (
                <Panel position="top-center">
                  <p className={`w-max rounded-md bg-surface-muted px-3 py-1 text-xs text-text-muted ${host && panelId ? "md:ml-[calc(var(--side-panel)*2)]" : ""}`}>{panelId ? "Mantenha Shift pressionado e clique para selecionar vários passos" : "Toque no passo para editar"}</p>
                </Panel>
              )}
            </ReactFlow>
          </div>
          {drop ? <ConnectDropMenu point={drop.screen} onPick={pickDrop} onCancel={() => setDrop(null)}
            groups={stepCatalog({ origin: nodes.find(n => n.id === drop.source)?.data.config, triggers, connections, hostChannel: host?.channel })} /> : null}
          {choosingChannel ? <StepChannelDialog channels={availableStepChannels(connections)} loading={catalog.loading}
            onCancel={() => setChoosingChannel(null)}
            onPick={channel => { const ask = choosingChannel; setChoosingChannel(null); addNode("message", ask.origin, ask.at, channel) }} /> : null}
          {preview !== null && previewEnv ? (
            <AutomationPreview
              key={preview}
              env={previewEnv}
              issue={catalog.loading ? "Carregando nomes de etiquetas e campos…" : catalog.error || Object.values(catalog.data?.errors ?? {}).some(Boolean) ? "Alguns nomes não carregaram; as notas podem mostrar “sem nome”." : undefined}
              onClose={() => setPreview(null)}
            />
          ) : null}
        </div>
      </div>
    </EditorProvider>
  )
}
