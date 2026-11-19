import type { IntegrationEnv } from '../integrations'
import { z } from 'zod'
export type FlowParams = { runId: string }
export type FlowEnv = IntegrationEnv & { FLOW_RUN: Workflow<FlowParams> }
export type Run = {
  id: string; workspace_id: string; contact_id: string; channel_id: string; channel_type: string;
  automation_version_id: string; automation_id: string; graph: string;
  start_node_id: string | null; depth: number; external_user_id: string;
  /** Execução raiz de quem foi iniciada por outra automação; vazio na própria raiz. */
  root_run_id?: string | null;
  system_confirmation?: 'system_opt_in' | 'system_opt_out' | null;
  /** Set when the run was born in a group and answers there. */
  comment_context?: string | null;
  story_context?: string | null;
  reply_group_thread_id?: string | null; reply_group_jid?: string | null;
}
export async function stableId(...parts: string[]): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)))
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}
export function object(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value)
}
