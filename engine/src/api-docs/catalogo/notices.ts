import type { AreaCatalogo } from '../tipos'
import { noticePreferencesSchema } from '../../notices'

export const area: AreaCatalogo = {
  area: 'notices',
  nome: 'Avisos',
  descricao: 'Avisos da conta, como conexão caída ou restrição do canal.',
  entradas: [
    { metodo: 'GET', caminho: '/api/notices', resumo: 'Lista os 50 avisos mais recentes da conta (conexão caída, restrição), com o total não lido, a restrição atual e as preferências de e-mail.' },
    { metodo: 'POST', caminho: '/api/notices/read', resumo: 'Marca todos os avisos da conta como lidos.' },
    { metodo: 'PUT', caminho: '/api/notices/preferences', resumo: 'Liga ou desliga, por tipo de aviso, o envio por e-mail ao dono da conta.', corpo: noticePreferencesSchema, exemplo: { connection: true, restriction: false } },
  ],
}
