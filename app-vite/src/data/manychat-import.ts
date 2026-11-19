import { apiRequest } from './api'
import type { Automation } from './types'

export type ManychatReportItem = { level: 'loss' | 'attention' | 'info'; code: string; message: string; node_id?: string; caption?: string }
export type ManychatImportResult = {
  automation: Automation
  created: boolean
  report: { nodes_in: number; nodes_out: number; items: ManychatReportItem[]; unsupported: Record<string, number>; summary: { loss: number; attention: number; info: number } }
  references: { kind: 'tag' | 'field' | 'sequence'; name: string; created: boolean; missing_in_origin: boolean }[]
  media?: { source_url: string; status: 'copied' | 'reused' | 'failed'; reason?: string }[]
  triggers?: { kind: string; name: string; status: 'created' | 'skipped'; reason?: string; notes?: string[] }[]
  source: { name: string | null }
  resolved_incoming_links: number
}

/** Link aceito pelo motor: app.manychat.com (flowPlayerPage, importSharedFlow) ou o hash solto. Conferência rápida antes de enviar. */
export function looksLikeManychatShare(value: string): boolean {
  const v = value.trim()
  if (/^\d{1,20}_[0-9a-f]{40}$/.test(v) || /^e2e_[a-z0-9_-]{1,40}$/.test(v)) return true
  try {
    const url = new URL(v)
    return url.protocol === 'https:' && url.hostname === 'app.manychat.com' && (url.searchParams.has('share_hash') || /\/importSharedFlow\/[^/]+/.test(url.pathname))
  } catch { return false }
}

export async function importManychatShared(input: { share_url: string; name?: string; folder_id?: string | null }): Promise<ManychatImportResult> {
  return apiRequest('/imports/manychat/shared', { method: 'POST', body: JSON.stringify(input) })
}

/** O que a ManyChat põe na área de transferência ao copiar blocos (tipo application/json): `{"$flowChart":"nodes", data:{nodesData...}}`. */
export function manychatClipboardFrom(data: DataTransfer | null): unknown | null {
  const raw = data?.getData('application/json')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { $flowChart?: unknown; data?: { nodesData?: unknown } }
    return parsed?.$flowChart === 'nodes' && Array.isArray(parsed.data?.nodesData) ? parsed : null
  } catch { return null }
}

export async function importManychatClipboard(input: { clipboard: unknown; name?: string; folder_id?: string | null }): Promise<ManychatImportResult> {
  return apiRequest('/imports/manychat', { method: 'POST', body: JSON.stringify(input) })
}

export type ManychatFragment = { graph: Automation['draft_graph']; report: ManychatImportResult['report']; references: ManychatImportResult['references']; media?: ManychatImportResult['media'] }

/**
 * Colar blocos da ManyChat já cria na conta as etiquetas, campos e sequências que faltam e copia a mídia, mesmo que o rascunho não seja salvo:
 * o aviso diz o que ficou criado. Vazio quando nada foi criado.
 */
export function fragmentCreatedSummary(fragment: Pick<ManychatFragment, 'references' | 'media'>): string {
  const label = { tag: ['etiqueta', 'etiquetas'], field: ['campo', 'campos'], sequence: ['sequência', 'sequências'] } as const
  const parts = (['tag', 'field', 'sequence'] as const).flatMap(kind => {
    const names = fragment.references.filter(r => r.kind === kind && r.created).map(r => `"${r.name}"`)
    return names.length ? [`${names.length > 1 ? label[kind][1] : label[kind][0]} ${names.join(', ')}`] : []
  })
  const copied = (fragment.media ?? []).filter(m => m.status === 'copied').length
  if (copied) parts.push(`${copied} ${copied > 1 ? 'arquivos de mídia copiados' : 'arquivo de mídia copiado'}`)
  return parts.length ? `Criado nesta conta (fica mesmo sem salvar): ${parts.join('; ')}.` : ''
}
/** Traduz blocos colados da ManyChat sem criar automação: o editor encaixa no rascunho aberto. */
export async function translateManychatFragment(clipboard: unknown): Promise<ManychatFragment> {
  return apiRequest('/imports/manychat/fragment', { method: 'POST', body: JSON.stringify({ clipboard }) })
}
