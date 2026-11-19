import { WS } from "./seed"
import { listAutomations } from "./index"
import { apiRequest, isFakeMode } from "./api"

export type SequenceWindow = { type: "all" } | { type: "timelimit"; from: string; to: string; weekdays: number[] }
export type SequenceStats = { sent: number; delivered: number; read: number; clicked: number; open_rate: number; ctr: number }
export type SequenceStep = {
  stats?: SequenceStats
  id: string
  delay_seconds: number
  sending_time_settings: SequenceWindow
  status: "live" | "draft"
  automation_id: string | null
}
export type Sequence = {
  id: string
  workspace_id: string
  name: string
  subscribers: number
  status: "active"
  steps: SequenceStep[]
  stats?: SequenceStats
}
export type SequenceInput = Pick<Sequence, "name" | "steps">
export type SequenceFlow = { id: string; name: string; published: boolean }

const sequences: Sequence[] = [
  {
    id: "seq-acolhimento", workspace_id: WS, name: "Acolhimento de novos inscritos", subscribers: 128, status: "active",
    steps: [
      { id: "step-boas-vindas", delay_seconds: 0, sending_time_settings: { type: "all" }, status: "live", automation_id: "auto-boas-vindas" },
      { id: "step-material", delay_seconds: 86400, sending_time_settings: { type: "timelimit", from: "09:00", to: "18:00", weekdays: [1, 2, 3, 4, 5] }, status: "live", automation_id: "auto-quero" },
      { id: "step-convite", delay_seconds: 7200, sending_time_settings: { type: "all" }, status: "draft", automation_id: null },
    ],
  },
  { id: "seq-jornada", workspace_id: WS, name: "Jornada de apresentação da coleção e acompanhamento de interesse", subscribers: 43, status: "active", steps: [{ id: "step-jornada", delay_seconds: 420, sending_time_settings: { type: "all" }, status: "draft", automation_id: null }] },
  { id: "seq-evento", workspace_id: WS, name: "Preparação para o encontro de novembro", subscribers: 0, status: "active", steps: [] },
]

// Métricas são somente leitura; o motor aceita apenas a configuração editável.
function editableSequence(input: SequenceInput): SequenceInput {
  return { name: input.name, steps: input.steps.map(({ id, delay_seconds, sending_time_settings, status, automation_id }) =>
    ({ id, delay_seconds, sending_time_settings, status, automation_id })) }
}

const copy = <T>(value: T): T => structuredClone(value)

export async function listSequences(workspaceId: string): Promise<Sequence[]> {
  if (!isFakeMode()) return apiRequest("/sequences")
  await Promise.resolve()
  return copy(sequences.filter((item) => item.workspace_id === workspaceId))
}

export async function listSequenceFlows(workspaceId: string): Promise<SequenceFlow[]> {
  if (!isFakeMode()) return apiRequest("/sequences/flows")
  const automations = await listAutomations(workspaceId)
  return automations.map(({ id, name, published_version_id }) => ({ id, name, published: published_version_id !== null }))
}

export function sequenceDelayUnit(seconds: number): { value: number; unit: number } {
  const unit = seconds > 0 ? [86400, 3600, 60].find((candidate) => seconds % candidate === 0) ?? 1 : 60
  return { value: seconds / unit, unit }
}

export function formatSequenceDelay(seconds: number): string {
  if (seconds === 0) return "Sem espera"
  const { value, unit } = sequenceDelayUnit(seconds)
  return `${value.toLocaleString("pt-BR")} ${unit === 86400 ? (value === 1 ? "dia" : "dias") : unit === 3600 ? "h" : unit === 60 ? "min" : "s"}`
}

async function validate(workspaceId: string, input: SequenceInput) {
  const flows = await listSequenceFlows(workspaceId)
  if (!input.name.trim() || input.name.trim().length > 120) throw new Error("Dê um nome de até 120 caracteres à sequência.")
  const ids = new Set<string>()
  for (const step of input.steps) {
    if (!step.id || ids.has(step.id)) throw new Error("Cada passo precisa de um identificador diferente.")
    ids.add(step.id)
    if (!Number.isSafeInteger(step.delay_seconds) || step.delay_seconds < 0 || step.delay_seconds > 99999 * 86400) throw new Error("Use um atraso válido, em segundos inteiros e sem valores negativos.")
    if (step.status !== "live" && step.status !== "draft") throw new Error("Escolha se o passo está em rascunho ou ao vivo.")
    if (step.status === "live" && !step.automation_id) throw new Error("Vincule uma automação antes de colocar o passo ao vivo.")
    const flow = flows.find((item) => item.id === step.automation_id)
    if (step.automation_id && !flow) throw new Error("A automação escolhida não pertence a este espaço.")
    if (step.status === "live" && !flow?.published) throw new Error("Publique a automação antes de colocar o passo ao vivo.")
    const window = step.sending_time_settings
    if (window.type === "timelimit") {
      const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/
      if (!validTime.test(window.from) || !validTime.test(window.to) || window.from >= window.to) throw new Error("A janela deve terminar depois do início, no mesmo dia.")
      if (!window.weekdays.length || window.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) || new Set(window.weekdays).size !== window.weekdays.length) throw new Error("Selecione ao menos um dia válido da semana.")
    } else if (window.type !== "all") throw new Error("Escolha uma janela de envio válida.")
  }
}

export async function createSequence(workspaceId: string, input: SequenceInput): Promise<Sequence> {
  if (!isFakeMode()) return apiRequest("/sequences", { method: "POST", body: JSON.stringify(editableSequence(input)) })
  await Promise.resolve()
  await validate(workspaceId, input)
  const sequence: Sequence = { id: `seq-${crypto.randomUUID()}`, workspace_id: workspaceId, name: input.name.trim(), subscribers: 0, status: "active", steps: copy(editableSequence(input).steps) }
  sequences.push(sequence)
  return copy(sequence)
}

export async function updateSequence(workspaceId: string, sequenceId: string, input: SequenceInput): Promise<Sequence> {
  if (!isFakeMode()) return apiRequest(`/sequences/${encodeURIComponent(sequenceId)}`, { method: "PATCH", body: JSON.stringify(editableSequence(input)) })
  await Promise.resolve()
  const sequence = sequences.find((item) => item.id === sequenceId && item.workspace_id === workspaceId)
  if (!sequence) throw new Error("A sequência não foi encontrada neste espaço.")
  await validate(workspaceId, input)
  sequence.name = input.name.trim()
  sequence.steps = copy(editableSequence(input).steps)
  return copy(sequence)
}

export async function deleteSequence(workspaceId: string, sequenceId: string): Promise<void> {
  if (!isFakeMode()) {
    await apiRequest(`/sequences/${encodeURIComponent(sequenceId)}`, { method: "DELETE" })
    return
  }
  const index = sequences.findIndex((item) => item.id === sequenceId && item.workspace_id === workspaceId)
  if (index < 0) throw new Error("A sequência não foi encontrada neste espaço.")
  sequences.splice(index, 1)
}

export type ContactSequence = {
  sequence_id: string; enrollment_id: string; name: string; next_step: number; next_at: number | null
  pending_run_id: string | null; created_at: number; connection_name: string | null
  /** Estado da inscrição (engine/src/flow/sequence-state.ts); `connection_ready` 0 = a agendada espera a conexão poder enviar. */
  state?: 'scheduled' | 'running' | 'finished'; connection_ready?: number
}
/** O que o painel diz de uma inscrição: a mesma regra de estado do motor. */
export function enrollmentLabel(s: Pick<ContactSequence, 'state' | 'pending_run_id' | 'next_at' | 'connection_ready'>, format = (at: number) => new Date(at).toLocaleString('pt-BR')): string {
  const state = s.state ?? (s.pending_run_id ? 'running' : s.next_at === null ? 'finished' : 'scheduled')
  if (state === 'running') return 'Passo em andamento'
  if (state === 'finished' || s.next_at === null) return 'Sem próximo envio agendado'
  return s.connection_ready === 0 ? `Próximo passo: ${format(s.next_at)} (aguardando a conexão poder enviar)` : `Próximo passo: ${format(s.next_at)}`
}
const demoSubscriptions = new Map<string, ContactSequence[]>()
export async function listContactSequences(contactId: string): Promise<ContactSequence[]> {
  if (!isFakeMode()) return apiRequest(`/contacts/${encodeURIComponent(contactId)}/sequences`)
  return copy(demoSubscriptions.get(contactId) ?? [])
}
export async function enrollContacts(ids: string[], sequenceId: string): Promise<{ count: number }> {
  if (!isFakeMode()) return apiRequest('/contacts/bulk-sequence', { method: 'POST', body: JSON.stringify({ ids, sequence_id: sequenceId }) })
  const sequence = sequences.find(s => s.id === sequenceId)
  if (!sequence) throw new Error('Sequência indisponível.')
  for (const id of new Set(ids)) {
    const current = demoSubscriptions.get(id) ?? []
    if (!current.some(s => s.sequence_id === sequenceId)) current.push({ sequence_id: sequenceId, enrollment_id: crypto.randomUUID(), name: sequence.name,
      next_step: 0, next_at: null, pending_run_id: null, created_at: Date.now(), connection_name: null, state: 'finished', connection_ready: 1 })
    demoSubscriptions.set(id, current)
  }
  return { count: new Set(ids).size }
}
export async function cancelContactSequence(contactId: string, sequenceId: string): Promise<void> {
  if (!isFakeMode()) { await apiRequest(`/contacts/${encodeURIComponent(contactId)}/sequences/${encodeURIComponent(sequenceId)}`, { method: 'DELETE' }); return }
  demoSubscriptions.set(contactId, (demoSubscriptions.get(contactId) ?? []).filter(s => s.sequence_id !== sequenceId))
}

/** Uma cópia compartilha as automações, mas começa com passos e inscrições próprios.
 *  Passo ao vivo cuja automação ainda não foi publicada nasce em rascunho (o motor recusa ativá-lo); `turnedOff` conta quantos. */
export async function duplicateSequence(workspaceId: string, sequence: Sequence): Promise<{ sequence: Sequence; turnedOff: number }> {
  const flows = await listSequenceFlows(workspaceId)
  let turnedOff = 0
  const steps = sequence.steps.map((step): SequenceStep => {
    const unpublished = step.status === "live" && !flows.find((flow) => flow.id === step.automation_id)?.published
    if (unpublished) turnedOff += 1
    return { ...step, id: `step-${crypto.randomUUID()}`, status: unpublished ? "draft" : step.status }
  })
  const created = await createSequence(workspaceId, { name: `${sequence.name.slice(0, 112)} (cópia)`, steps })
  return { sequence: created, turnedOff }
}
