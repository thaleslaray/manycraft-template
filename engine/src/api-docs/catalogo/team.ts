import type { AreaCatalogo } from '../tipos'
import { agencyProfileSchema, teamAccessApproveSchema, teamInviteSchema, teamMemberPatchSchema } from '../../team'

// Área team: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'team',
  nome: 'Equipe',
  descricao: 'Membros do espaço, convites e permissões.',
  entradas: [
    { metodo: 'GET', caminho: '/api/team', resumo: 'Lista os membros do espaço com papel, assento no inbox e e-mail.' },
    { metodo: 'PATCH', caminho: '/api/team/:id', resumo: 'Muda o papel ou o assento no inbox de um membro; rebaixar abaixo de administrador revoga as chaves de API dele.', corpo: teamMemberPatchSchema, exemplo: { role: 'editor', inbox_seat: true } },
    { metodo: 'DELETE', caminho: '/api/team/:id', resumo: 'Remove um membro do espaço e revoga as chaves de API dele (você não pode se remover).' },
    { metodo: 'GET', caminho: '/api/team/assignees', resumo: 'Lista os membros que podem receber conversas (com assento no inbox, mais o dono).' },
    { metodo: 'GET', caminho: '/api/team/notifications', resumo: 'As 100 notificações mais recentes da equipe destinadas a você ou a todos.' },
    { metodo: 'GET', caminho: '/api/team/invites', resumo: 'Lista os convites ainda válidos.' },
    { metodo: 'POST', caminho: '/api/team/invites', resumo: 'Convida uma pessoa por e-mail com um papel; o convite vale 24 horas.', corpo: teamInviteSchema, exemplo: { email: 'maria@exemplo.com', role: 'editor' } },
    { metodo: 'DELETE', caminho: '/api/team/invites/:id', resumo: 'Cancela um convite.' },
    { metodo: 'POST', caminho: '/api/team/invites/:id/link', resumo: 'Gera um novo link para o convite (o link anterior para de valer); mande corpo `{}`.' },
    { metodo: 'GET', caminho: '/api/team/access-requests', resumo: 'Lista os pedidos de acesso ao espaço feitos por pessoas sem vínculo.' },
    { metodo: 'POST', caminho: '/api/team/access-requests/:id/approve', resumo: 'Aprova um pedido de acesso e põe a pessoa na equipe com o papel escolhido.', corpo: teamAccessApproveSchema, exemplo: { role: 'viewer' } },
    { metodo: 'DELETE', caminho: '/api/team/access-requests/:id', resumo: 'Recusa um pedido de acesso.' },
  ],
}
