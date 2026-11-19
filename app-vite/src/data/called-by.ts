import { apiRequest, isFakeMode } from "./api"

export type CalledBy = { id: string; name: string; waits: boolean }

/** Automações publicadas que iniciam esta pelo passo "Iniciar automação". */
export async function listCalledBy(automationId: string): Promise<CalledBy[]> {
  if (isFakeMode()) return []
  return (await apiRequest<{ rows: CalledBy[] }>(`/automations/${encodeURIComponent(automationId)}/called-by`)).rows
}
