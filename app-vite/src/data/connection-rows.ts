/** Regras puras das linhas da tela da conexão (o painel só desenha o resultado). */
type ConnectionLike = {
  status?: string
  profile?: { conversationStarters?: unknown }
  webhook?: { mode: "auto" | "manual"; registered: boolean; url: string | null; subscribedAt: number | null; note?: string | null }
}

/** Iniciadores de conversa só aparecem quando o perfil do canal os oferece (o Básico também só os mostra nesse caso). */
export const offersConversationStarters = (connection: ConnectionLike) => !!connection.profile?.conversationStarters

export type WebhookState = { tone: "ok" | "waiting" | "off"; label: string; text: string; url: string | null; guide: boolean }
/** Estado do webhook em palavras simples: configurado (e recebendo), aguardando o primeiro evento, ou não configurado. */
export function webhookState(connection: ConnectionLike): WebhookState {
  const hook = connection.webhook ?? { mode: "manual" as const, registered: false, url: null, subscribedAt: null }
  const url = hook.url
  // Assinado pelo servidor no provedor, mas a primeira entrega real ainda não chegou: só ela prova que os eventos chegam.
  if (connection.status === "pending" && hook.subscribedAt !== null)
    return { tone: "waiting", label: "Aguardando o primeiro evento", url, guide: false,
      text: `${hook.note ? `${hook.note} ` : ""}Nenhum evento chegou ainda. Mande uma mensagem para este número de outro aparelho para testar; esta tela atualiza sozinha.` }
  if (hook.registered) return hook.mode === "auto"
    ? { tone: "ok", label: "Configurado automaticamente", url, guide: false, text: hook.note ?? "O webhook foi registrado no provedor por este sistema." }
    : { tone: "ok", label: "Configurado", url, guide: false, text: "O provedor confirmou o endereço e os eventos chegam aqui." }
  if (hook.mode === "auto") return { tone: "off", label: "Não configurado", url, guide: false, text: "O webhook não foi registrado. Use Trocar credencial para tentar de novo." }
  return { tone: "off", label: "Não configurado", url, guide: connection.status === "pending",
    text: "Cole o endereço e o token de verificação no painel do provedor; o passo a passo mostra onde." }
}
