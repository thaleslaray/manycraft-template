import type { AreaCatalogo } from '../tipos'
import { enabledSchema } from '../../schemas/enabled'

// Área pixel: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'pixel',
  nome: 'Pixel',
  descricao: 'Pixel do site: ligar, desligar e ver os eventos recebidos.',
  entradas: [
    { metodo: 'GET', caminho: '/api/pixel', resumo: 'Diz se o Pixel está ligado e mostra os 100 eventos mais recentes, com o contato.' },
    { metodo: 'PUT', caminho: '/api/pixel', resumo: 'Liga ou desliga o Pixel do espaço.', corpo: enabledSchema, exemplo: { enabled: true } },
  ],
}
