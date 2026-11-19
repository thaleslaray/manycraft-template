import type { AreaCatalogo } from '../tipos'
import { appInstallSchema } from '../../apps'

// Área apps: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'apps',
  nome: 'Apps',
  descricao: 'Apps instalados no espaço, com as ações e gatilhos que oferecem às automações.',
  entradas: [
    { metodo: 'GET', caminho: '/api/apps', resumo: 'Lista os apps instalados no espaço, com ações, gatilhos e parâmetros de autenticação.' },
    { metodo: 'POST', caminho: '/api/apps', resumo: 'Instala um app a partir da especificação JSON e dos parâmetros de chave (testa a autenticação antes).', corpo: appInstallSchema,
      exemplo: { spec: { name: 'Meu CRM', auth: { type: 'APIKEY', params: [{ name: 'api_key', label: 'Chave da API' }], connection: { headers: { Authorization: 'Bearer {{api_key}}' } } },
        actions: [{ name: 'criar_lead', label: 'Criar lead', requests: [{ method: 'POST', url: 'https://api.exemplo.com/leads' }] }] }, params: { api_key: 'SUA_CHAVE_AQUI' } } },
    { metodo: 'DELETE', caminho: '/api/apps/:id', resumo: 'Desinstala o app.' },
    { metodo: 'GET', caminho: '/api/apps/:id/sources/:name', resumo: 'Opções de um campo de seleção do app (lista fixa ou buscada no serviço).' },
  ],
}
