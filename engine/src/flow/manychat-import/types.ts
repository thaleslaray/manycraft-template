import { z } from 'zod'

/** O JSON da ManyChat é de terceiros e muda sem aviso: só o esqueleto é validado, o resto é lido com cuidado. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type J = Record<string, any>
const loose = z.record(z.string(), z.unknown())
export const clipboardSchema = z.object({
  $flowChart: z.literal('nodes'),
  pageId: z.string().optional(),
  data: z.object({
    nodesData: z.array(z.object({
      node: z.object({ id: z.string().min(1), nodeType: z.string().min(1) }).passthrough(),
      related: z.object({ blocks: z.array(loose).default([]), buttons: z.array(loose).default([]) }).default({ blocks: [], buttons: [] }),
    })),
    offsets: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).default({}),
  }).passthrough(),
}).passthrough()
export type Clipboard = z.infer<typeof clipboardSchema>
export type NodeData = Clipboard['data']['nodesData'][number]

export type FieldKind = 'text' | 'number' | 'date' | 'datetime' | 'boolean'
/** Resolve as referências numéricas da ManyChat para ids do workspace. O motor pré-resolve (cria o que falta); aqui tudo é síncrono. */
export interface RefResolver {
  tag(id: string): string
  field(id: string): { id: string; type: FieldKind }
  sequence(id: string): string
  /** Fluxo (namespace) já importado neste workspace, ou null. */
  automation(ns: string): string | null
}

export type ReportLevel = 'loss' | 'attention' | 'info'
export type ReportItem = { level: ReportLevel; code: string; message: string; node_id?: string; caption?: string }
export type ImportReport = {
  source: { ns: string | null; page_id: string | null }
  nodes_in: number
  nodes_out: number
  items: ReportItem[]
  /** Rótulo do que não entrou -> quantas vezes (tipo de nó, ação, bloco, condição). */
  unsupported: Record<string, number>
  media: { node_id: string; url: string }[]
  summary: { loss: number; attention: number; info: number }
}
export type GraphNode = { id: string; type: string; position: { x: number; y: number }; config: Record<string, unknown> }
export type GraphEdge = { from: string; port: string; to: string }
export type ImportedGraph = { nodes: GraphNode[]; edges: GraphEdge[]; origin: { source: 'manychat'; ns: string | null; page_id: string | null } }
