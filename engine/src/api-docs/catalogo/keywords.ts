import type { AreaCatalogo } from '../tipos'
import { keywordAutomationInputSchema, keywordPatchSchema, keywordPrioritySchema, keywordRuleInputSchema } from '../../db/keywords'
import { z } from 'zod'

const regraResposta = z.object({
  id: z.string(),
  name: z.string(),
  channel: z.string().describe('Canal da conexão do gatilho.'),
  automation_id: z.string(),
  priority: z.number().int().describe('Posição na ordem de prioridade, a partir de 0.'),
  active: z.boolean(),
  rules: z.array(z.object({
    condition: z.enum(['contains', 'equals', 'word', 'starts', 'not_contains', 'thumbs_up']),
    words: z.array(z.string()),
  })).describe('Até duas condições sobre o texto da mensagem.'),
  audience: z.enum(['direct', 'group']).describe('`direct` conversa individual, `group` mensagem de grupo.'),
  group_match: z.enum(['keyword', 'mention']).nullable(),
  connection_id: z.string().nullable(),
  group_thread_id: z.string().nullable(),
})

// Área keywords: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'keywords',
  nome: 'Palavras-chave',
  descricao: 'Palavras que disparam automações quando o contato as manda.',
  entradas: [
    { metodo: 'GET', caminho: '/api/keywords', resumo: 'Lista as regras de palavra-chave em ordem de prioridade, com a automação que cada uma dispara.', resposta: z.array(regraResposta) },
    { metodo: 'POST', caminho: '/api/keywords', resumo: 'Cria uma regra de palavra-chave (até duas condições) que dispara uma automação.', corpo: keywordRuleInputSchema, exemplo: { name: 'Preço', channel: 'instagram', automation_id: 'auto-1', active: true, rules: [{ condition: 'contains', words: ['preço', 'valor'] }] } },
    { metodo: 'PATCH', caminho: '/api/keywords/:id', resumo: 'Liga ou desliga a regra (`{ "active": false }`) ou a regrava inteira (mesmo corpo da criação).', corpo: keywordPatchSchema, exemplo: { active: false } },
    { metodo: 'DELETE', caminho: '/api/keywords/:id', resumo: 'Exclui a regra de palavra-chave.' },
    { metodo: 'PATCH', caminho: '/api/keywords/:id/priority', resumo: 'Move a regra para outra posição na ordem de prioridade (`target`, a partir de 0).', corpo: keywordPrioritySchema, exemplo: { target: 0 } },
    { metodo: 'POST', caminho: '/api/keywords/automation', resumo: 'Cria a regra de palavra-chave junto com uma automação nova; com `keyword_id`, uma regra existente passa a disparar a nova.', corpo: keywordAutomationInputSchema, exemplo: { name: 'Cupom', channel: 'instagram', rules: [{ condition: 'equals', words: ['cupom'] }] } },
  ],
}
