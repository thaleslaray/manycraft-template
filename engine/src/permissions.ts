import { HTTPException } from 'hono/http-exception'
import { roleCan, roles, type Action, type Role } from '../../shared/permissions'
export type { Action, Role } from '../../shared/permissions'
export type Principal = { userId: string; workspaceId: string; role: Role }
export function can(user: Principal | null, action: Action, record: { workspace_id: string }): boolean {
  if (!user || user.workspaceId !== record.workspace_id) return false
  return roleCan(user.role, action)
}
export function authorize(user: Principal, action: Action) {
  if (!can(user, action, { workspace_id: user.workspaceId })) throw new HTTPException(403, { message: 'Seu papel não permite esta ação.' })
}
/** Papel do auto-login de desenvolvimento: dono, ou DEV_ROLE para ver o painel como outro papel. */
export function devRole(env: { DEV_ROLE?: string }): Role {
  return roles.find(r => r === env.DEV_ROLE) ?? 'owner'
}
