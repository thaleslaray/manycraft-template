import { apiRequest, isFakeMode } from "./api"

/** Catálogo de atendimento, disponível a quem pode ler automações. */
export async function listActionMembers(): Promise<{ id: string; name: string }[]> {
  if (isFakeMode()) return [{ id: "owner", name: "Responsável pelo espaço" }]
  const members = await apiRequest<{ id: string; role: string }[]>("/team/assignees")
  return members.map(member => ({ id: member.id, name: `${member.role === "owner" ? "Proprietário" : "Pessoa da equipe"} (${member.id.slice(0, 8)})` }))
}
