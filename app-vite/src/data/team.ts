import type { Role } from '../../../shared/permissions'
import { apiRequest, forgetAfterWrite, isFakeMode } from './api'

export type TeamRole = Role
export type TeamMember = { id: string; name: string; email: string; role: TeamRole; inbox_seat: boolean; is_current: boolean; image?: string | null }
export type TeamInvite = { id: string; email: string; role: Exclude<TeamRole, 'owner'>; expires_at: number }
export type IssuedInvite = { id: string; url: string; expires_at: number }
export const teamRoleLabels: Record<TeamRole, string> = {
  owner: 'Proprietário', administrator: 'Administrador', editor: 'Editor', livechat_agent: 'Agente da caixa de entrada', viewer: 'Visualizador',
}

const demoMembers: TeamMember[] = [
  { id: 'demo-owner', name: 'Lia Exemplo', email: 'lia@exemplo.com', role: 'owner', inbox_seat: true, is_current: true },
  { id: 'demo-agent', name: 'Ana Ribeiro', email: 'ana@exemplo.com', role: 'livechat_agent', inbox_seat: false, is_current: false },
]
const demoInvites: TeamInvite[] = []

export async function getTeam() {
  if (isFakeMode()) return structuredClone({ members: demoMembers, invites: demoInvites.filter(invite => invite.expires_at > Date.now()) })
  const [members, invites] = await Promise.all([apiRequest<TeamMember[]>('/team'), apiRequest<TeamInvite[]>('/team/invites')])
  return { members, invites }
}

export async function inviteTeamMember(email: string, role: TeamInvite['role']): Promise<IssuedInvite> {
  if (!isFakeMode()) return apiRequest('/team/invites', { method: 'POST', body: JSON.stringify({ email, role }) })
  if (demoMembers.some(m => m.email === email) || demoInvites.some(i => i.email === email && i.expires_at > Date.now())) throw new Error('Este e-mail já está na equipe ou tem um convite válido.')
  const invite = { id: crypto.randomUUID(), email, role, expires_at: Date.now() + 86400_000 }
  demoInvites.push(invite)
  return { id: invite.id, expires_at: invite.expires_at, url: 'Demonstração: convite simulado' }
}

export async function updateTeamMember(id: string, input: { role?: TeamInvite['role']; inbox_seat?: boolean }) {
  if (!isFakeMode()) return apiRequest(`/team/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) })
  const member = demoMembers.find(m => m.id === id)
  if (!member || member.role === 'owner') throw new Error('Este membro não pode ser alterado.')
  Object.assign(member, input)
}

export async function removeTeamMember(id: string) {
  if (!isFakeMode()) return apiRequest(`/team/${encodeURIComponent(id)}`, { method: 'DELETE' })
  const index = demoMembers.findIndex(m => m.id === id)
  if (index < 0 || demoMembers[index]!.role === 'owner') throw new Error('Este membro não pode ser removido.')
  demoMembers.splice(index, 1)
}

export async function cancelTeamInvite(id: string) {
  if (!isFakeMode()) return apiRequest(`/team/invites/${encodeURIComponent(id)}`, { method: 'DELETE' })
  const index = demoInvites.findIndex(i => i.id === id)
  if (index < 0) throw new Error('Convite não encontrado.')
  demoInvites.splice(index, 1)
}

/** O motor só guarda o hash do token: copiar o link de um convite pendente emite um link novo (o anterior para de valer). */
export async function reissueInviteLink(id: string): Promise<IssuedInvite> {
  if (!isFakeMode()) return apiRequest(`/team/invites/${encodeURIComponent(id)}/link`, { method: 'POST', body: '{}' })
  const invite = demoInvites.find(i => i.id === id)
  if (!invite) throw new Error('Convite não encontrado.')
  return { id, expires_at: invite.expires_at, url: 'Demonstração: convite simulado' }
}

/** Sem sessão: para qual e-mail o link do convite vale (null se o link não vale mais ou não há motor). */
export async function previewInvite(token: string): Promise<string | null> {
  if (isFakeMode() || !token) return null
  const response = await fetch('/api/invite-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
  if (!response.ok) return null
  return ((await response.json().catch(() => null)) as { email?: string } | null)?.email ?? null
}

export async function transferTeamOwnership(member_id: string, confirmation: string) {
  if (!isFakeMode()) return apiRequest('/team/transfer-ownership', { method: 'POST', body: JSON.stringify({ member_id, confirmation }) })
  const member = demoMembers.find(m => m.id === member_id)
  if (!member || confirmation !== 'TRANSFERIR') throw new Error('Confirme a transferência para um membro ativo.')
  demoMembers.filter(m => m.role === 'owner').forEach(m => { m.role = 'administrator' })
  member.role = 'owner'
}

export async function signOutEverywhere() {
  if (!isFakeMode()) await apiRequest('/account/sign-out-everywhere', { method: 'POST', body: '{}' })
}

// Aceitar não exige um workspace prévio: evita criar um espaço pessoal no bootstrap.
export async function acceptTeamInvite(token: string): Promise<{ workspace_id: string }> {
  const response = await fetch('/api/invites/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).finally(() => forgetAfterWrite('POST', '/invites/accept'))
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error || 'Não foi possível aceitar o convite.')
  return body
}

export const pendingInviteKey = 'pending-team-invite'

export type AccessRequest = { id: string; email: string; name: string | null; message: string; created_at: number }
export async function listAccessRequests(): Promise<AccessRequest[]> {
  if (isFakeMode()) return []
  return (await apiRequest<{ items: AccessRequest[] }>('/team/access-requests')).items
}
export const approveAccessRequest = (id: string, role: TeamInvite['role']) => apiRequest(`/team/access-requests/${id}/approve`, { method: 'POST', body: JSON.stringify({ role }) })
export const denyAccessRequest = (id: string) => apiRequest(`/team/access-requests/${id}`, { method: 'DELETE' })
// Pedir acesso não exige vínculo com o espaço: vai sem cabeçalho de workspace.
export async function requestWorkspaceAccess(workspace_id: string, message: string) {
  const response = await fetch('/api/access-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id, message }) }).finally(() => forgetAfterWrite('POST', '/access-requests'))
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Não foi possível enviar o pedido.')
}
