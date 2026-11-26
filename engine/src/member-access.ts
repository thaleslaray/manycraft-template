import type { Env } from './env'

/**
 * O que precisa acontecer quando alguém deixa de ter acesso ao espaço (removido, saiu, rebaixado, conta excluída):
 * as chaves de API do espaço que a pessoa criou são revogadas (com um aviso ao dono) e a conexão ao vivo do inbox cai.
 * `workspaceId` nulo vale para todos os espaços (exclusão de conta). Chaves sem criador (`created_by` nulo) não são tocadas.
 */
export function revokeMemberKeys(db: D1Database, workspaceId: string | null, userId: string, reason: string, afterChange = false): D1PreparedStatement[] {
  const now = Date.now()
  return [
    // `afterChange`: só revoga se o comando anterior do lote (a mudança de membro) alterou uma linha.
    db.prepare(`UPDATE api_keys SET revoked_at=? WHERE created_by=? AND revoked_at IS NULL AND (? IS NULL OR workspace_id=?)${afterChange ? ' AND changes()=1' : ''}`)
      .bind(now, userId, workspaceId, workspaceId),
    // O aviso lê as chaves que acabaram de ser revogadas: sem chave revogada, não há aviso.
    db.prepare(`INSERT INTO workspace_notices (workspace_id,kind,message)
      SELECT DISTINCT workspace_id,'restriction','A chave de API criada por ' || coalesce((SELECT coalesce(nullif(name,''),email) FROM "user" WHERE id=?),'um membro') || ' foi desativada porque ' || ? || '. Gere outra em Configurações.'
      FROM api_keys WHERE created_by=? AND revoked_at=? AND (? IS NULL OR workspace_id=?)`).bind(userId, reason, userId, now, workspaceId, workspaceId),
  ]
}

/** Fecha (4001) as conexões ao vivo do inbox da pessoa. Chamado só depois de a mudança no banco dar certo; uma falha aqui não desfaz nada. */
export async function disconnectMember(env: Pick<Env, 'INBOX_HUB'>, workspaceIds: string[], userId: string) {
  if (!env.INBOX_HUB) return
  for (const workspaceId of workspaceIds) {
    try { await env.INBOX_HUB.get(env.INBOX_HUB.idFromName(workspaceId)).disconnectUser(userId) }
    catch (error) { console.error('inbox_disconnect_failed', workspaceId, error instanceof Error ? error.message : 'erro') }
  }
}
