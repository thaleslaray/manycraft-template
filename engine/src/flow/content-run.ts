import { dynamicBlocks, type DynamicResponse } from './dynamic-block'
import { ensureWorkflow } from './dispatch'
import type { FlowEnv } from './types'

/** Envia conteúdo no formato v2 ao contato por uma automação interna escondida (excluída, só com a versão usada pelo run). */
export async function sendDynamicContent(env: FlowEnv, workspace: string, contactId: string, channelId: string, content: DynamicResponse, name = 'Envio pela API') {
  const key = crypto.randomUUID(), automation = `api-content-${key}`, version = `api-content-v-${key}`, runId = `api-${key}`
  const graph = { nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'm', type: 'message', position: { x: 300, y: 0 }, config: { blocks: dynamicBlocks(content) } }],
    edges: [{ from: 't', port: 'next', to: 'm' }] }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automations (id,workspace_id,name,status,draft_graph,deleted_at) VALUES (?,?,?,'live',?,?)").bind(automation, workspace, name, JSON.stringify(graph), Date.now()),
    env.DB.prepare('INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES (?,?,?,1,?)').bind(version, workspace, automation, JSON.stringify(graph)),
    env.DB.prepare('INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id) VALUES (?,?,?,?,?)').bind(runId, workspace, contactId, version, channelId),
  ])
  await ensureWorkflow(env, runId)
  return runId
}
