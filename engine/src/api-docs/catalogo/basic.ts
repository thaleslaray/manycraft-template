import type { AreaCatalogo } from '../tipos'
import { basicEntrySchema } from '../../basic-actions'
import { surfaceConfigSchema } from '../../conversation-surfaces'

// Área basic: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'basic',
  nome: 'Automações básicas',
  descricao: 'Por conexão: resposta padrão, boas-vindas e demais entradas básicas do canal.',
  entradas: [
    { metodo: 'GET', caminho: '/api/basic', resumo: 'Conexões e as automações básicas de cada uma: resposta padrão, boas-vindas e confirmações de inscrição e descadastro.' },
    { metodo: 'PUT', caminho: '/api/basic/:connection/:kind', resumo: 'Liga uma automação publicada a uma entrada básica da conexão (`default_reply`, `welcome_message`, `system_opt_in`, `system_opt_out`).', corpo: basicEntrySchema, exemplo: { automation_id: 'auto-1', enabled: true, repeat_mode: 'every_time', dm_only: false } },
    { metodo: 'GET', caminho: '/api/basic/:connection/surfaces/:kind', resumo: 'Rascunho e versão publicada dos iniciadores de conversa ou do menu principal da conexão, com cliques por item.' },
    { metodo: 'PUT', caminho: '/api/basic/:connection/surfaces/:kind', resumo: 'Salva o rascunho dos iniciadores de conversa ou do menu principal (itens que abrem automações).', corpo: surfaceConfigSchema, exemplo: { enabled: true, items: [{ id: 'precos', title: 'Ver preços', automation_id: 'auto-1' }] } },
    { metodo: 'POST', caminho: '/api/basic/:connection/surfaces/:kind/publish', resumo: 'Publica no canal o rascunho dos iniciadores de conversa ou do menu principal.' },
    { metodo: 'POST', caminho: '/api/basic/:connection/system_opt_out/default', resumo: 'Cria, publica e liga o fluxo padrão de confirmação de descadastro da conexão.' },
  ],
}
