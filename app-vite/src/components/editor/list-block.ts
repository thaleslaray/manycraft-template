import type { Connection } from "@/data/connections"
import { isListBlock, listError, listLimits, listRows, type ListBlock, type ListLimits, type ListProfile } from "../../../../engine/src/schemas/message-list"
export { isListBlock, listError, listRows, type ListBlock, type ListLimits }

export const listProfiles = (connections: Connection[]): ListProfile[] => connections.map(c => ({ list: c.profile?.list }))

/** O que a lista pode ter neste passo: o menor limite entre as conexões do canal; null quando alguma não oferece lista (o painel nem mostra o bloco). */
export const sharedListLimits = (connections: Connection[]): ListLimits | null => listLimits(listProfiles(connections))

/** Identificador estável da opção; é por ele que a saída da opção é ligada no mapa. */
export function newListRowId(block: ListBlock): string {
  const used = new Set(listRows(block).map(r => r.id))
  let n = 1
  while (used.has(`l${n}`)) n++
  return `l${n}`
}

/** Lista nova: já com uma seção e duas opções em branco, para o formato ficar claro. */
export function emptyList(): ListBlock {
  return { kind: "list", buttonText: "", sections: [{ rows: [{ id: "l1", title: "" }, { id: "l2", title: "" }] }] }
}
