/** Papéis do espaço e o que cada um pode fazer. Fonte única para o motor (que recusa) e o painel (que esconde). */
export type Role = 'owner' | 'administrator' | 'editor' | 'livechat_agent' | 'viewer'
export type Action = 'read' | 'automation:read' | 'edit' | 'team' | 'upload' | 'inbox:reply' | 'contact:pause'
export const roles: readonly Role[] = ['owner', 'administrator', 'editor', 'livechat_agent', 'viewer']
export function roleCan(role: Role, action: Action): boolean {
  if (action === 'team') return role === 'owner' || role === 'administrator'
  if (action === 'edit' || action === 'upload') return role === 'owner' || role === 'administrator' || role === 'editor'
  if (action === 'automation:read') return role !== 'livechat_agent'
  // Responder, atribuir e encerrar conversa: todo papel menos o leitor.
  if (action === 'inbox:reply') return role !== 'viewer'
  // Pausar e retomar a automação de um contato: quem edita e o atendente da caixa.
  if (action === 'contact:pause') return role !== 'viewer'
  return true
}
