import type { AreaCatalogo } from '../tipos'
import { notificationTopicCreateSchema } from '../../notification-topics'

export const area: AreaCatalogo = {
  area: 'notification-topics',
  nome: 'Tópicos de notificação',
  descricao: 'Assuntos que o contato assina para receber mensagens fora da janela de 24 h.',
  entradas: [
    { metodo: 'GET', caminho: '/api/notification-topics', resumo: 'Lista os tópicos de notificação por conexão, com inscritos ativos, os que vencem em 7 dias e os vencidos ou parados.' },
    { metodo: 'POST', caminho: '/api/notification-topics', resumo: 'Cria um tópico de notificação numa conexão, com frequência e validade da inscrição em dias.', corpo: notificationTopicCreateSchema, exemplo: { channel_id: 'ch-instagram', name: 'Ofertas da semana', frequency: 'weekly', validity_days: 180 } },
    { metodo: 'DELETE', caminho: '/api/notification-topics/:id', resumo: 'Exclui o tópico de notificação.' },
  ],
}
