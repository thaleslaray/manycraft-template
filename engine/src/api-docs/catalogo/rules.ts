import type { AreaCatalogo } from '../tipos'
import { ruleActiveSchema } from '../../rules/routes'
import { ruleInputSchema } from '../../rules/schema'

const exemploRegra = { name: 'Marcar cliente ao comprar', trigger: { type: 'tag_added' }, event_filter: { tag_id: 'tag-comprou' }, actions: [{ type: 'add_tag', tag_id: 'tag-cliente' }], frequency: 'once' }

// Área rules: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'rules',
  nome: 'Regras',
  descricao: 'Regras automáticas: quando algo acontece com o contato, faça uma ação.',
  entradas: [
    { metodo: 'GET', caminho: '/api/rules', resumo: 'Lista as regras (gatilho que dispara ações no contato) do espaço, com execuções e contatos únicos.' },
    { metodo: 'POST', caminho: '/api/rules', resumo: 'Cria uma regra em rascunho: gatilho, filtro do evento, condição opcional e ações.', corpo: ruleInputSchema, exemplo: exemploRegra },
    { metodo: 'GET', caminho: '/api/rules/:id', resumo: 'Mostra a regra com o rascunho e a versão publicada.' },
    { metodo: 'PUT', caminho: '/api/rules/:id', resumo: 'Substitui o rascunho da regra (a versão publicada só muda ao publicar).', corpo: ruleInputSchema, exemplo: exemploRegra },
    { metodo: 'PATCH', caminho: '/api/rules/:id', resumo: 'Liga ou desliga a regra publicada.', corpo: ruleActiveSchema, exemplo: { active: true } },
    { metodo: 'DELETE', caminho: '/api/rules/:id', resumo: 'Exclui a regra.' },
    { metodo: 'POST', caminho: '/api/rules/:id/duplicate', resumo: 'Cria uma cópia da regra a partir do rascunho, com "(cópia)" no nome.' },
    { metodo: 'POST', caminho: '/api/rules/:id/publish', resumo: 'Publica o rascunho da regra, que passa a valer para os próximos eventos.' },
  ],
}
