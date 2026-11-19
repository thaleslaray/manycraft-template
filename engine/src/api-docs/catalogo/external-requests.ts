import type { AreaCatalogo } from '../tipos'
import { externalRequestLogsQuerySchema, externalRequestTestSchema } from '../../external-requests'

export const area: AreaCatalogo = {
  area: 'external-requests',
  nome: 'Requisições externas',
  descricao: 'Testar as requisições HTTP das automações e ver os registros delas.',
  entradas: [
    { metodo: 'GET', caminho: '/api/external-requests/logs', resumo: 'Lista os registros das requisições externas das últimas 2 semanas, com nível (erro, aviso, informação) e filtros por automação e tipo.', query: externalRequestLogsQuerySchema },
    { metodo: 'POST', caminho: '/api/external-requests/test', resumo: 'Executa de teste uma ação de requisição externa para um contato e devolve status, duração, prévia da resposta e campos mapeados.', corpo: externalRequestTestSchema, exemplo: { action: { type: 'external_request', method: 'GET', url: 'https://api.exemplo.com.br/pedidos/status', mappings: [{ path: 'status', field_id: 'f-plano' }] }, contact_id: 'c1' } },
  ],
}
