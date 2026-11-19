import { HTTPException } from 'hono/http-exception'
import type { IntegrationEnv } from '../../integrations'
import { messageNodeTypes, validateGraph } from '../../schemas/graph'
import { connectionRuntime } from './runtime'

/** Follow every path before the opening reply: an action or branch must not hide a delay. */
export async function assertCommentPublishable(env: IntegrationEnv, ws: string, automation: string, rawGraph: string) {
  const triggers = await env.DB.prepare("SELECT channel_id,config,like_comment,public_replies FROM triggers WHERE workspace_id=? AND automation_id=? AND kind='widget' AND widget_type IN ('feed_comment','feed_comment_trigger')").bind(ws, automation).all<{ channel_id: string | null; config: string; like_comment: number; public_replies: string }>()
  if (!triggers.results.length) return
  const graph = validateGraph(JSON.parse(rawGraph))
  const refuse = (reason: string): never => { throw new HTTPException(409, { message: `Não dá para publicar: ${reason}` }) }
  for (const t of triggers.results) {
    if (!t.channel_id) refuse('escolha uma conexão para o comentário.')
    const rt = await connectionRuntime(env, ws, t.channel_id!, { secrets: false, requireConnected: true })
    if (rt.connection.status !== 'connected') refuse('confirme o webhook da conexão antes de publicar.')
    const caps = rt.connection.profile.comments
    if (!rt.connection.profile.inbound.comment || !caps?.privateReply || !rt.provider?.comments) refuse('a conexão não aceita resposta privada a comentário.')
    if (JSON.parse(t.config).target === 'next' && !caps!.posts) refuse('a conexão não consegue localizar a próxima publicação.')
    if (JSON.parse(t.public_replies).length && !caps!.publicReply) refuse('a conexão não aceita a resposta pública configurada.')
    const start = JSON.parse(t.config).node_id ?? graph.nodes.find(n => n.type === 'trigger')?.id
    const visiting = new Set<string>(), visited = new Set<string>()
    const walk = (id: string) => {
      if (visiting.has(id)) refuse('há um ciclo antes da primeira interação.')
      if (visited.has(id)) return
      visiting.add(id)
      const node = graph.nodes.find(n => n.id === id)
      if (!node) refuse('falta um passo do gatilho de comentário.')
      if (['smart_delay', 'question', 'start_automation', 'goto'].includes(node!.type)) refuse('remova a espera, a pergunta ou o desvio antes da primeira interação de comentário.')
      const edges = graph.edges.filter(e => e.from === id)
      if (messageNodeTypes.includes(node!.type)) {
        const blocks = node!.config.blocks ?? [], texts = blocks.filter(b => 'kind' in b && b.kind === 'text'), buttons = blocks.filter(b => 'kind' in b && b.kind === 'button')
        if (texts.length !== 1 || buttons.length > caps!.privateReply!.urlButtonsMax || blocks.length !== texts.length + buttons.length) refuse('a primeira resposta de comentário aceita só um texto e até um botão (de link ou de toque).')
        const text = String((texts[0] as { text: string }).text)
        if (!text.trim() || new TextEncoder().encode(text).length > Math.min(caps!.privateReply!.textMaxLength, buttons.length ? 640 : 1000)) refuse('o texto da primeira resposta excede o limite da conexão.')
        for (const b of buttons) {
          const button = b as { id: string; label: string; action: { type: string; url?: string } }
          if (!['url', 'go_to_node'].includes(button.action.type)) refuse('o botão da primeira resposta só pode abrir um link ou levar ao próximo passo ao ser tocado.')
          if (!button.label?.trim() || [...button.label].length > rt.connection.profile.buttons.titleMax) refuse('o botão da primeira resposta precisa de um rótulo dentro do limite da conexão.')
          if (button.action.type === 'url' && !/^https?:\/\/[^\s]+$/.test(button.action.url ?? '')) refuse('a primeira resposta exige botão com link válido.')
        }
        // Abrir um link não responde nada; só o toque no botão de toque é uma resposta da pessoa, e é depois dele que o fluxo pode seguir.
        const tapPort = buttons.length && (buttons[0] as { action: { type: string } }).action.type === 'go_to_node' ? `btn:${(buttons[0] as { id: string }).id}` : undefined
        if (edges.some(e => e.port !== tapPort)) refuse('a resposta privada não abre janela: só o toque no botão da resposta (depois do toque, quando a pessoa responde) pode levar a outro passo. Tire a ligação direta ou a de tempo esgotado.')
      } else {
        if (!edges.length) refuse('ligue o gatilho a uma resposta privada.')
        edges.forEach(e => walk(e.to))
      }
      visiting.delete(id); visited.add(id)
    }
    walk(start)
  }
}
