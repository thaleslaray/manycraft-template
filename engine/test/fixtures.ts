import { env } from 'cloudflare:workers'
import type { Graph } from '../src/contracts'
import { giveCredentials } from './credentials'

export const graph: Graph = {
  nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'm', type: 'message', position: { x: 200, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Olá!' }] } },
  ],
  edges: [{ from: 't', port: 'next', to: 'm' }],
}

export async function seed() {
  await env.DB.prepare('DELETE FROM workspaces').run()
  await env.DB.batch(['a', 'b'].flatMap((ws) => [
    env.DB.prepare('INSERT INTO workspaces (id,name) VALUES (?,?)').bind(ws, `Workspace ${ws}`),
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES (?,?,'instagram',?)").bind(`ch-${ws}`, ws, `external-${ws}`),
    env.DB.prepare('INSERT INTO contacts (id,workspace_id,first_name,last_name,subscribed_at) VALUES (?,?,?,?,?)')
      .bind(`c-${ws}`, ws, 'Mariana', ws === 'a' ? 'Oliveira' : 'Silveira', 1000),
    env.DB.prepare('INSERT INTO tags (id,workspace_id,name) VALUES (?,?,?)').bind(`tag-${ws}`, ws, `Etiqueta ${ws}`),
    env.DB.prepare("INSERT INTO custom_fields (id,workspace_id,name,type) VALUES (?,?,?,'text')").bind(`field-${ws}`, ws, 'Interesse'),
    env.DB.prepare('INSERT INTO automations (id,workspace_id,name,draft_graph) VALUES (?,?,?,?)').bind(`auto-${ws}`, ws, `Automação ${ws}`, JSON.stringify(graph)),
    env.DB.prepare("INSERT INTO triggers (id,workspace_id,automation_id,channel_id,name,kind,status,config) VALUES (?,?,?,?,?,'keyword','active',?)")
      .bind(`trg-${ws}`, ws, `auto-${ws}`, `ch-${ws}`, `Palavra ${ws}`, JSON.stringify({ include: ['quero'], exclude: [] })),
    env.DB.prepare("INSERT INTO keywords (id,workspace_id,trigger_id,rule,words,priority) VALUES (?,?,?,'contains',?,1)")
      .bind(`key-${ws}`, ws, `trg-${ws}`, '["quero"]'),
    env.DB.prepare('INSERT INTO contact_tags (workspace_id,contact_id,tag_id) VALUES (?,?,?)').bind(ws, `c-${ws}`, `tag-${ws}`),
    env.DB.prepare('INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value) VALUES (?,?,?,?)').bind(ws, `c-${ws}`, `field-${ws}`, '"Curso"'),
    env.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES (?,?,?,?,?,1)")
      .bind(`cc-${ws}`, ws, `c-${ws}`, `ch-${ws}`, `user-${ws}`),
  ]))
  // Tests that turn these into Telegram connections send with this bot; Instagram/WhatsApp tests store their own.
  for (const ws of ['a', 'b']) await giveCredentials(env, `ch-${ws}`, { botToken: 'TESTONLY', webhookSecret: `seed-secret-${ws}` })
}
