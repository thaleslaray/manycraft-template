import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'

/** De quanto em quanto tempo o hub confere se a sessão de cada socket ainda vale. */
export const SESSION_RECHECK_MS = 2 * 60_000

/** Only the authenticated Worker can address this workspace-scoped object. */
export class InboxHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 })
    const { 0: client, 1: server } = new WebSocketPair()
    // Quem é o dono do socket vem da sessão, posta pelo Worker neste cabeçalho (só ele alcança este objeto); a tag permite desconectá-lo depois.
    const userId = request.headers.get('x-inbox-user')
    if (!userId) return new Response(null, { status: 400 })
    this.ctx.acceptWebSocket(server, [`user:${userId}`])
    // A sessão em que o socket abriu também vem do Worker (nunca do cliente). Sem sessão (login automático de desenvolvimento), o socket não é revalidado.
    const sessionId = request.headers.get('x-inbox-session')
    if (sessionId) {
      server.serializeAttachment({ sessionId })
      if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + SESSION_RECHECK_MS)
    }
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    return new Response(null, { status: 101, webSocket: client })
  }

  /** Chamado só pelo Worker: a pessoa perdeu o acesso ao espaço, então todas as conexões dela caem (4001). */
  async disconnectUser(userId: string): Promise<void> {
    for (const socket of this.ctx.getWebSockets(`user:${userId}`)) {
      try { socket.close(4001, 'Acesso revogado.') } catch { /* já fechado */ }
    }
  }

  /** Alarme de revalidação: fecha (4001) o socket cuja sessão não existe mais ou expirou (senha redefinida, sessões revogadas pelas rotas nativas, 7 dias).
   * Uma consulta por lote de sockets. Só se agenda de novo enquanto houver socket com sessão: sem eles o objeto pode hibernar. */
  async alarm(): Promise<void> {
    const open = this.ctx.getWebSockets().flatMap(socket => {
      const sessionId = (socket.deserializeAttachment() as { sessionId?: string } | null)?.sessionId
      return sessionId ? [{ socket, sessionId }] : []
    })
    if (!open.length) return
    try {
      const ids = [...new Set(open.map(o => o.sessionId))], alive = new Set<string>(), now = Date.now()
      for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90)
        const rows = await this.env.DB.prepare(`SELECT id,"expiresAt" FROM "session" WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ id: string; expiresAt: string | number }>()
        for (const row of rows.results) if ((typeof row.expiresAt === 'number' ? row.expiresAt : Date.parse(row.expiresAt)) > now) alive.add(row.id)
      }
      for (const { socket, sessionId } of open) if (!alive.has(sessionId)) { try { socket.close(4001, 'Sessão encerrada.') } catch { /* já fechado */ } }
      if (open.some(o => alive.has(o.sessionId))) await this.ctx.storage.setAlarm(Date.now() + SESSION_RECHECK_MS)
    } catch {
      // Falha passageira na consulta: não derruba ninguém e tenta de novo no próximo intervalo.
      await this.ctx.storage.setAlarm(Date.now() + SESSION_RECHECK_MS)
    }
  }

  async notify(event: unknown): Promise<void> {
    const body = JSON.stringify(event)
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(body) } catch { socket.close(1011, 'Reconecte para atualizar a conversa.') }
    }
  }

  webSocketMessage(_socket: WebSocket, _message: string | ArrayBuffer): void {}
  // 1005/1006/1015 are receive-only codes; echoing them throws, so answer a normal close instead.
  webSocketClose(socket: WebSocket, code: number): void { socket.close(code >= 1000 && code < 5000 && ![1005, 1006, 1015].includes(code) ? code : 1000) }
  webSocketError(socket: WebSocket): void { socket.close(1011, 'Reconecte para atualizar a conversa.') }
}
