import type { AreaCatalogo } from '../tipos'
import { contactBulkCopyFieldSchema, contactBulkDeleteSchema, contactBulkTagSchema, contactExportSchema, contactListQuerySchema, contactPatchSchema, contactPauseSchema, contactTagSchema } from '../../contacts'
import { contactBulkPauseSchema, contactBulkUnsubscribeSchema, contactCleanupSchema, contactDataRequestSchema, contactMergePreviewSchema, contactMergeSchema } from '../../contact-portability'
import { contactBulkSequenceSchema } from '../../contact-sequences'
import { contactCreateSchema } from '../../contact-imports'
import { contactQuerySchema } from '../../segments'
import { contactFieldValueSchema } from '../../settings'

// Área piloto (ficha 01). Veja em ./index.ts como preencher uma área.
export const area: AreaCatalogo = {
  area: 'contacts',
  nome: 'Contatos',
  descricao: 'Os contatos do espaço: dados, tags, campos, sequências e ações em massa.',
  entradas: [
    { metodo: 'GET', caminho: '/api/contacts', resumo: 'Lista os contatos do espaço, 50 por página (use `next_cursor` em `cursor`), com os filtros rápidos da tela de contatos.', query: contactListQuerySchema },
    { metodo: 'POST', caminho: '/api/contacts', resumo: 'Cria um contato à mão, com e-mail e telefone.', corpo: contactCreateSchema, exemplo: { first_name: 'Ana', last_name: 'Souza', email: 'ana@exemplo.com', phone: '+55 11 91234-5678' } },
    { metodo: 'GET', caminho: '/api/contacts/:id', resumo: 'Mostra o contato com canais, tags e campos.' },
    { metodo: 'PATCH', caminho: '/api/contacts/:id', resumo: 'Altera nome, gênero, idioma, fuso ou a inscrição do contato (mande ao menos um campo).', corpo: contactPatchSchema, exemplo: { first_name: 'Ana', status: 'subscribed' } },
    { metodo: 'DELETE', caminho: '/api/contacts/:id', resumo: 'Exclui o contato e apaga as conversas, respostas e dados ligados a ele.' },
    { metodo: 'GET', caminho: '/api/contacts/:id/avatar', resumo: 'Foto do contato (JPEG); 404 quando não tem foto.', respostaTipo: 'image/jpeg' },
    { metodo: 'GET', caminho: '/api/contacts/:id/data-requests', resumo: 'Lista os pedidos do titular registrados para o contato (acesso, exportação, correção...).' },
    { metodo: 'POST', caminho: '/api/contacts/:id/data-requests', resumo: 'Registra um pedido do titular, com data e quem registrou.', corpo: contactDataRequestSchema, exemplo: { kind: 'export', note: 'Pediu por e-mail.' } },
    { metodo: 'GET', caminho: '/api/contacts/:id/export', resumo: 'Exporta em JSON todos os dados do contato: perfil, canais, tags, campos e conversas com mensagens.' },
    { metodo: 'PUT', caminho: '/api/contacts/:id/fields/:fieldId', resumo: 'Grava o valor de um campo personalizado do contato.', corpo: contactFieldValueSchema, exemplo: { value: 'Plano anual' } },
    { metodo: 'PUT', caminho: '/api/contacts/:id/pause', resumo: 'Pausa as automações do contato até a data informada (`null` retoma).', corpo: contactPauseSchema, exemplo: { until: '2026-12-31T23:59:00-03:00' } },
    { metodo: 'GET', caminho: '/api/contacts/:id/sequences', resumo: 'Lista as sequências em que o contato está inscrito, com o próximo passo.' },
    { metodo: 'DELETE', caminho: '/api/contacts/:id/sequences/:sequence', resumo: 'Tira o contato de uma sequência.' },
    { metodo: 'POST', caminho: '/api/contacts/:id/tags', resumo: 'Põe ou tira uma tag do contato.', corpo: contactTagSchema, exemplo: { tag_id: 'tag-cliente', op: 'add' } },
    { metodo: 'POST', caminho: '/api/contacts/bulk-copy-field', resumo: 'Copia um campo personalizado para o e-mail ou o telefone de até 100 contatos; valor inválido ou já usado é pulado.', corpo: contactBulkCopyFieldSchema, exemplo: { ids: ['c1', 'c2'], field_id: 'f-email', target: 'email' } },
    { metodo: 'POST', caminho: '/api/contacts/bulk-delete', resumo: 'Exclui até 100 contatos de uma vez.', corpo: contactBulkDeleteSchema, exemplo: { ids: ['c1', 'c2'] } },
    { metodo: 'POST', caminho: '/api/contacts/bulk-pause', resumo: 'Pausa as automações de até 100 contatos por tempo indeterminado.', corpo: contactBulkPauseSchema, exemplo: { ids: ['c1'], confirmation: 'PAUSAR' } },
    { metodo: 'POST', caminho: '/api/contacts/bulk-sequence', resumo: 'Inscreve até 100 contatos inscritos e com conexão ativa numa sequência.', corpo: contactBulkSequenceSchema, exemplo: { ids: ['c1'], sequence_id: 'seq-boas-vindas' } },
    { metodo: 'POST', caminho: '/api/contacts/bulk-tag', resumo: 'Põe ou tira uma tag de até 100 contatos.', corpo: contactBulkTagSchema, exemplo: { ids: ['c1', 'c2'], tag_id: 'tag-cliente', op: 'add' } },
    { metodo: 'POST', caminho: '/api/contacts/bulk-unsubscribe', resumo: 'Descadastra até 100 contatos e retira o consentimento nos canais.', corpo: contactBulkUnsubscribeSchema, exemplo: { ids: ['c1'], confirmation: 'DESCADASTRAR' } },
    { metodo: 'POST', caminho: '/api/contacts/cleanup', resumo: 'Limpeza da lista: conta (sem `apply`) ou marca, descadastra ou exclui os contatos sem interação há N dias.', corpo: contactCleanupSchema, exemplo: { inactive_days: 180, action: 'tag', tag_id: 'tag-inativo' } },
    { metodo: 'POST', caminho: '/api/contacts/export', resumo: 'Exporta em CSV os contatos escolhidos (`ids`), os de um filtro avançado (`filter`) ou os dos filtros rápidos (`query`).', corpo: contactExportSchema, exemplo: { query: { status: 'subscribed' } } },
    { metodo: 'POST', caminho: '/api/contacts/merge', resumo: 'Junta dois contatos: o secundário passa canais, tags, campos e histórico para o principal e some.', corpo: contactMergeSchema, exemplo: { primary_id: 'c1', secondary_id: 'c2', confirmation: 'MESCLAR' } },
    { metodo: 'POST', caminho: '/api/contacts/merge-preview', resumo: 'Compara dois contatos antes de juntar e diz se há conflito de canal.', corpo: contactMergePreviewSchema, exemplo: { primary_id: 'c1', secondary_id: 'c2' } },
    { metodo: 'POST', caminho: '/api/contacts/query', resumo: 'Busca contatos por filtro avançado (o mesmo dos segmentos), com paginação por cursor.', corpo: contactQuerySchema, exemplo: { filter: { match: 'all', rules: [{ type: 'tag', tag_id: 'tag-cliente', operator: 'has' }] } } },
  ],
}
