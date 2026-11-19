import type { AreaCatalogo } from '../tipos'
import { automationTemplateInstallSchema, automationTemplatesQuerySchema } from '../../automation-templates'

// Área automation-templates: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'automation-templates',
  nome: 'Modelos de automação',
  descricao: 'Modelos de automação para reaproveitar entre espaços.',
  entradas: [
    { metodo: 'GET', caminho: '/api/automation-templates', resumo: 'Lista os modelos de automação; com `connection_id`, avisa o que a conexão não suporta.', query: automationTemplatesQuerySchema },
    { metodo: 'POST', caminho: '/api/automation-templates', resumo: 'Instala um modelo: cria a automação em rascunho com gatilho e palavra-chave na conexão escolhida.', corpo: automationTemplateInstallSchema, exemplo: { template_id: 'boas-vindas', version: 1, connection_id: 'conn-instagram', word: 'quero' } },
    { metodo: 'GET', caminho: '/api/automation-templates/installed', resumo: 'Lista os modelos já instalados no espaço, com quem instalou e a automação gerada.' },
  ],
}
