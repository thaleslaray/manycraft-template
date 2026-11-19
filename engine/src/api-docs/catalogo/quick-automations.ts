import type { AreaCatalogo } from '../tipos'
import { quickAutomationSchema } from '../../quick-automations'

// Área quick-automations: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'quick-automations',
  nome: 'Automações rápidas',
  descricao: 'Montar numa chamada uma automação de resposta a palavra, comentário ou menção.',
  entradas: [
    { metodo: 'POST', caminho: '/api/quick-automations', resumo: 'Monta numa chamada uma automação de resposta (palavra na DM, comentário ou menção em story) com mensagem e botão opcional, já publicada por padrão.', corpo: quickAutomationSchema, exemplo: { goal: 'keyword', name: 'Link do curso', connection_id: 'conn-instagram', words: ['curso'], message: 'Aqui está o link!', button: { label: 'Abrir', url: 'https://exemplo.com/curso' } } },
  ],
}
