import * as React from "react"
import type { Automation, AutomationStats, Tag, Trigger } from "@/data"

import type { Catalogs, EditorField } from "./graph"

export type EditorCtx = {
  readOnly: boolean
  /** Automação (não transmissão): o passo publicado mostra Enviado, Entregue, Aberto e Clicado, com traço onde o canal não informa. */
  fullMetrics?: boolean
  stats: AutomationStats | null
  triggers: Trigger[]
  tags: Tag[]
  sequences?: Catalogs["sequences"]
  fields?: EditorField[]
  botFields?: EditorField[]
  segments?: { id: string; name: string }[]
  automations?: Automation[]
  errors: Record<string, string[]>
  showErrors: boolean
  /** Barra flutuante do passo selecionado (duplicar e apagar). */
  duplicateStep?: (id: string) => void
  deleteStep?: (id: string) => void
  /** "+ Novo gatilho" do nó: abre o pop-up "Iniciar automação quando…". */
  newTrigger?: (nodeId: string) => void
  /** Linha de gatilho do nó: abre o painel desse gatilho. */
  pickTrigger?: (triggerId: string) => void
}

const Ctx = React.createContext<EditorCtx | null>(null)
export const EditorProvider = Ctx.Provider

export function useEditor(): EditorCtx {
  const v = React.useContext(Ctx)
  if (!v) throw new Error("useEditor fora do EditorProvider")
  return v
}
