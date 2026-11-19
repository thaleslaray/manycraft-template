import type { AreaCatalogo } from '../tipos'
import { alertChatLinkSchema, memberAlertsSchema } from '../../team-alerts'

// Área me: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'me',
  nome: 'Minha conta',
  descricao: 'Preferências do usuário dono da chave.',
  entradas: [
    { metodo: 'GET', caminho: '/api/me/alerts', resumo: 'Suas preferências de aviso: e-mail, chat vinculado e quais eventos avisam.' },
    { metodo: 'PUT', caminho: '/api/me/alerts', resumo: 'Grava suas preferências de aviso por e-mail e os eventos que avisam.', corpo: memberAlertsSchema, exemplo: { email_enabled: true, alert_email: null, on_assigned_message: true, on_unassigned: false, on_assigned_to_me: true } },
    { metodo: 'POST', caminho: '/api/me/alerts/chat-link', resumo: 'Gera um código e um link para vincular seus avisos a uma conexão de chat.', corpo: alertChatLinkSchema, exemplo: { channel_id: 'canal-telegram' } },
    { metodo: 'DELETE', caminho: '/api/me/alerts/chat', resumo: 'Desvincula o chat dos seus avisos.' },
  ],
}
