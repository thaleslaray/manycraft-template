import { graphSchema } from '../schemas/graph'
import type { Graph } from '../contracts'
import type { ChannelProfile } from '../channels/contract'

/** Conteúdo próprio. Mudanças no conteúdo ou na configuração exigem uma nova versão. */
export type AutomationTemplate = {
  id: string; version: number; name: string; description: string; category: 'Recepção' | 'Vendas' | 'Atendimento'
  icon: 'welcome' | 'link' | 'clock' | 'map' | 'calendar' | 'help'
  trigger: { kind: 'keyword' | 'welcome_message'; word?: string; label: string }
  link?: { label: string; url: string }
  graph: Graph
}
const message = (text: string, link?: { label: string; url: string }) => ({ blocks: [
  { kind: 'text', text }, ...(link ? [{ kind: 'button', id: 'abrir', label: link.label, action: { type: 'url', url: link.url } }] : []),
] })
function model(input: Omit<AutomationTemplate, 'version' | 'graph'> & { text: string }): AutomationTemplate {
  const { text, ...meta } = input
  const graph = graphSchema.parse({
    template: { id: input.id, version: 1 },
    nodes: [
      { id: 'inicio', type: 'trigger', position: { x: 0, y: 80 }, config: {} },
      { id: 'resposta', type: 'message', position: { x: 360, y: 80 }, config: message(text, input.link) },
    ], edges: [{ from: 'inicio', port: 'next', to: 'resposta' }],
  }) as Graph
  return { ...meta, version: 1, graph }
}
export const automationTemplates: AutomationTemplate[] = [
  model({ id: 'boas-vindas', name: 'Boas-vindas', description: 'Receba quem escreve pela primeira vez com uma apresentação do seu atendimento.', category: 'Recepção', icon: 'welcome',
    trigger: { kind: 'welcome_message', label: 'Na primeira mensagem do contato' }, text: 'Olá! Que bom ter você por aqui. Conte o que procura para começarmos o atendimento.' }),
  model({ id: 'link-palavra', name: 'Link por palavra-chave', description: 'Entregue um material quando a pessoa enviar a palavra combinada.', category: 'Vendas', icon: 'link',
    trigger: { kind: 'keyword', word: 'material', label: 'Quando a mensagem contém “material”' }, link: { label: 'Abrir material', url: 'https://example.com/material' },
    text: 'Aqui está o material que você pediu. Toque abaixo para abrir.' }),
  model({ id: 'horarios', name: 'Horários de atendimento', description: 'Responda às dúvidas sobre os dias e horários de funcionamento.', category: 'Atendimento', icon: 'clock',
    trigger: { kind: 'keyword', word: 'horário', label: 'Quando a mensagem contém “horário”' }, text: 'Atendemos de segunda a sexta, das 9h às 18h. Deixe sua dúvida por aqui e nossa equipe dará continuidade.' }),
  model({ id: 'endereco', name: 'Como chegar', description: 'Compartilhe o endereço e as orientações para uma visita.', category: 'Atendimento', icon: 'map',
    trigger: { kind: 'keyword', word: 'endereço', label: 'Quando a mensagem contém “endereço”' }, text: 'Nosso ponto de encontro fica na Rua das Oficinas, 100. Ao chegar, procure a recepção. Ajuste este endereço antes de publicar.' }),
  model({ id: 'agendamento', name: 'Link de agendamento', description: 'Ajude a pessoa a escolher um horário na sua página de reservas.', category: 'Vendas', icon: 'calendar',
    trigger: { kind: 'keyword', word: 'agendar', label: 'Quando a mensagem contém “agendar”' }, link: { label: 'Escolher horário', url: 'https://example.com/agenda' },
    text: 'Vamos marcar uma conversa? Abra a agenda abaixo e escolha o melhor horário para você.' }),
  model({ id: 'ajuda', name: 'Orientação de atendimento', description: 'Explique como pedir ajuda e quais informações enviar à equipe.', category: 'Atendimento', icon: 'help',
    trigger: { kind: 'keyword', word: 'ajuda', label: 'Quando a mensagem contém “ajuda”' }, text: 'Para ajudar com seu pedido, envie o número da compra e descreva sua dúvida. Nossa equipe continuará a conversa por aqui.' }),
]

/** Somente a ficha efetiva decide compatibilidade; nenhum nome de canal é consultado. */
export function templateWarnings(model: AutomationTemplate, profile: ChannelProfile): string[] {
  const warnings: string[] = []
  if (!profile.inbound.message) warnings.push('Esta conexão não recebe mensagens para iniciar este modelo.')
  for (const node of model.graph.nodes) {
    const blocks = (node.config.blocks ?? []) as { kind?: string; text?: string; label?: string }[]
    const buttons = blocks.filter(b => b.kind === 'button')
    if (buttons.length && !profile.buttons.types.includes('url')) warnings.push('Esta conexão não permite botão de link. Escolha outra conexão ou um modelo sem botão.')
    if (buttons.length > profile.buttons.maxPerMessage) warnings.push('O modelo excede o limite de botões desta conexão.')
    if (buttons.some(b => [...(b.label ?? '')].length > profile.buttons.titleMax)) warnings.push('O título do botão excede o limite desta conexão.')
    for (const block of blocks.filter(b => b.kind === 'text')) {
      const length = profile.text.unit === 'bytes' ? new TextEncoder().encode(block.text ?? '').length : [...(block.text ?? '')].length
      if (length > profile.text.maxLength) warnings.push('O texto do modelo excede o limite desta conexão.')
    }
  }
  return [...new Set(warnings)]
}
