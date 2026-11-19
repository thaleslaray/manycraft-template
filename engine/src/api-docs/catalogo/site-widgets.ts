import type { AreaCatalogo } from '../tipos'
import { siteWidgetCreateSchema, siteWidgetDiagnoseSchema } from '../../site-widgets'

// Área site-widgets: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'site-widgets',
  nome: 'Widgets do site',
  descricao: 'Botões e janelas para pôr no seu site e captar contatos.',
  entradas: [
    { metodo: 'GET', caminho: '/api/site-widgets', resumo: 'Lista os widgets de site do espaço.' },
    { metodo: 'POST', caminho: '/api/site-widgets', resumo: 'Cria um widget de site que leva o visitante ao endereço HTTPS informado.', corpo: siteWidgetCreateSchema, exemplo: { label: 'Botão do site', target_url: 'https://wa.me/5511912345678' } },
    { metodo: 'DELETE', caminho: '/api/site-widgets/:id', resumo: 'Exclui o widget.' },
    { metodo: 'POST', caminho: '/api/site-widgets/:id/diagnose', resumo: 'Confere uma página: usa HTTPS, o domínio responde e carrega o script do widget uma vez só.', corpo: siteWidgetDiagnoseSchema, exemplo: { page_url: 'https://exemplo.com' } },
  ],
}
