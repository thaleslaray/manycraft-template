import type { Connection } from "./connections"
import type { ProfileAnswers } from "./workspace-settings"

export type QuickGoal = "keyword" | "comment" | "story_mention"
export type Objective = Exclude<ProfileAnswers["goal"], "skip">

/** Caso de uso pronto: o que o assistente de automação rápida já preenche; o usuário só completa palavra, canal e link. */
export type UseCase = {
  id: string; objective: Objective; title: string; detail: string; goal: QuickGoal
  name: string; words: string[]; message: string
  /** Botão com link: o texto já vem preenchido, o link o usuário informa. */
  buttonLabel?: string
}

export const useCases: UseCase[] = [
  { id: "comment-contact", objective: "leads", title: "Comentário vira contato", detail: "Quem comenta uma palavra recebe a mensagem no privado e entra na sua lista.", goal: "comment",
    name: "Comentário vira contato", words: ["quero"], message: "Oi! Vi seu comentário e já te mandei os detalhes por aqui. Responda esta mensagem se tiver qualquer dúvida." },
  { id: "keyword-contact", objective: "leads", title: "Captar contato por palavra", detail: "Quem manda a palavra no privado recebe as boas-vindas e fica na sua lista.", goal: "keyword",
    name: "Captar contato por palavra", words: ["oi"], message: "Olá! Que bom ter você por aqui. Me conta o que você procura e eu te ajudo." },
  { id: "keyword-coupon", objective: "sales", title: "Cupom por palavra-chave", detail: "Quem manda a palavra recebe o cupom e o link da loja na hora.", goal: "keyword",
    name: "Cupom por palavra-chave", words: ["cupom"], message: "Aqui está o seu cupom de desconto! Use na hora de finalizar a compra.", buttonLabel: "Ir para a loja" },
  { id: "keyword-faq", objective: "support", title: "Respostas às perguntas frequentes", detail: "Palavras como preço, horário e entrega já recebem a resposta certa.", goal: "keyword",
    name: "Perguntas frequentes", words: ["preço", "horário", "entrega"], message: "Obrigado pela pergunta! Aqui estão as informações mais pedidas. Se precisar de mais alguma coisa, é só responder.", buttonLabel: "Ver detalhes" },
  { id: "comment-gift", objective: "engagement", title: "Brinde para quem comenta", detail: "Comentou no post, recebe o brinde no direct.", goal: "comment",
    name: "Brinde para quem comenta", words: ["brinde"], message: "Obrigado por comentar! Seu brinde está aqui.", buttonLabel: "Pegar meu brinde" },
  { id: "story-thanks", objective: "engagement", title: "Agradecer quem menciona no story", detail: "Quem marca a sua conta num story recebe um agradecimento uma única vez.", goal: "story_mention",
    name: "Agradecer menção no story", words: [], message: "Valeu por me marcar no seu story! Fiquei muito feliz." },
]

export const casesFor = (objective: Objective) => useCases.filter(c => c.objective === objective)

/** Conexões que aceitam o objetivo do caso (mesma regra do assistente). */
export function eligibleConnections(goal: QuickGoal, connections: Connection[]): Connection[] {
  return connections.filter(c => c.status === "connected" && (goal === "comment" ? c.profile?.inbound?.comment && c.profile.comments?.privateReply : goal === "story_mention" ? c.profile?.stories?.mention : c.profile?.inbound?.message))
}

/** Disponível quando algum canal conectado serve; senão traz o motivo para mostrar no cartão desabilitado. */
export function availability(useCase: UseCase, connections: Connection[]): { ok: true } | { ok: false; reason: string } {
  if (eligibleConnections(useCase.goal, connections).length) return { ok: true }
  if (useCase.goal === "comment") return { ok: false, reason: "Precisa de uma conta do Instagram conectada para ler comentários." }
  if (useCase.goal === "story_mention") return { ok: false, reason: "Precisa de uma conta do Instagram conectada para receber menções em story." }
  return { ok: false, reason: "Precisa de um canal de mensagens conectado." }
}
