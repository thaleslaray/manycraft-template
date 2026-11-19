/** O que a Meta avisou sobre a conta do WhatsApp, em linguagem de negócio e com o que fazer. Função pura: o painel só desenha o resultado. */
export type AccountHealth = Record<string, any>
export type HealthTone = "ok" | "info" | "attention" | "critical"
export type HealthItem = { id: string; tone: HealthTone; title: string; text: string; action?: string }

const tierLabels: Record<string, string> = { TIER_50: "50", TIER_250: "250", TIER_1K: "1.000", TIER_2K: "2.000", TIER_10K: "10.000", TIER_100K: "100.000" }
const number = new Intl.NumberFormat("pt-BR")
const day = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" })
const unlimited = (value: unknown) => value === "TIER_UNLIMITED" || value === "UNLIMITED" || value === -1
/** "2.000" para o número ou o nível; `null` quando não dá para dizer. */
function limitText(value: unknown): string | null {
  if (typeof value === "number") return value > 0 ? number.format(value) : null
  return typeof value === "string" ? tierLabels[value] ?? null : null
}

const qualityEvents: Record<string, Omit<HealthItem, "id">> = {
  THROUGHPUT_UPGRADE: { tone: "ok", title: "Velocidade de envio ampliada", text: "A Meta liberou mais mensagens por segundo neste número." },
  ONBOARDING: { tone: "info", title: "Número em ativação", text: "A Meta ainda está liberando este número. O limite de envio pode ser menor nos primeiros dias." },
  FLAGGED: { tone: "attention", title: "Qualidade do número em queda", text: "Muitas pessoas bloquearam ou denunciaram as mensagens deste número.",
    action: "Envie só para quem pediu para receber, revise o texto dos modelos e espere a Meta voltar a liberar o número." },
  UNFLAGGED: { tone: "ok", title: "Qualidade do número recuperada", text: "A Meta voltou a considerar a qualidade deste número boa." },
  UPGRADE: { tone: "ok", title: "Limite de envio aumentado", text: "A Meta aumentou quantas pessoas diferentes você pode iniciar conversa por dia." },
  DOWNGRADE: { tone: "attention", title: "Limite de envio reduzido", text: "A Meta reduziu quantas pessoas diferentes você pode iniciar conversa por dia, por causa da qualidade.",
    action: "Pare transmissões grandes por alguns dias e revise os modelos com pior qualidade." },
}

const alertTypes: Record<string, { title: string; text: string; action?: string }> = {
  INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED: { title: "A Meta adiou o aumento do seu limite", text: "O limite de envio não vai subir por enquanto.",
    action: "Use o WhatsApp de forma ativa por alguns dias e siga as políticas de mensagens; a Meta avalia de novo." },
  INCREASED_CAPABILITIES_ELIGIBILITY_FAILED: { title: "A Meta negou o aumento do seu limite", text: "Seu limite de envio continua o mesmo.",
    action: "Confira a verificação do negócio no Gerenciador de Negócios e a qualidade das suas mensagens antes de pedir de novo." },
  INCREASED_CAPABILITIES_ELIGIBILITY_NEED_MORE_INFO: { title: "A Meta pediu mais informações para aumentar o limite", text: "Sem essas informações o limite não sobe.",
    action: "Abra o Gerenciador de Negócios, vá em Segurança e complete a verificação do negócio." },
  // Not from the Meta: raised by this system when a message arrived without the contact's BSUID and was discarded (engine meta-whatsapp-health.ts).
  NO_BSUID: { title: "Mensagens sem o identificador do contato foram descartadas", text: "Chegou mensagem sem o BSUID do contato, e o sistema só guarda contatos por esse identificador.",
    action: "Confirme na Meta se os identificadores de usuário (BSUID) estão ativos para o seu negócio. Se o aviso persistir, avise o suporte." },
  PROFILE_PICTURE_LOST: { title: "A foto do perfil do WhatsApp foi perdida", text: "O contato vê o número sem foto.", action: "Envie a foto de novo no Gerenciador do WhatsApp." },
}
const alertTone: Record<string, HealthTone> = { CRITICAL: "critical", WARNING: "attention", INFORMATIONAL: "info" }

const restrictionTypes: Record<string, string> = {
  RESTRICTED_BIZ_INITIATED_MESSAGING: "Não é possível iniciar conversas novas (você ainda responde a quem escreve primeiro)",
  RESTRICTED_ADD_PHONE_NUMBER_ACTION: "Não é possível adicionar novos números a esta conta",
}
const violationTypes: Record<string, string> = { ADULT: "conteúdo adulto", ALCOHOL: "bebidas alcoólicas", DATING: "relacionamentos", GAMBLING: "jogos de azar", DRUGS: "drogas", HEALTH: "produtos de saúde", WEAPONS: "armas" }

type SendBlock = { entity: string; status: string; errors?: { code: number; description?: string; solution?: string }[]; info?: string[] }
const sendingEntities: Record<string, string> = { WABA: "Conta do WhatsApp Business (WABA)", BUSINESS: "Portfólio empresarial", APP: "App da Meta", PHONE_NUMBER: "Número", MESSAGE_TEMPLATE: "Modelo de mensagem" }
const sendingErrors: Record<number, { text: string; action: string }> = {
  141006: { text: "há um problema com a forma de pagamento, e a Meta bloqueia as conversas iniciadas pela empresa (modelos)",
    action: "No Gerenciador de Negócios da Meta, abra Configurações de pagamento da conta do WhatsApp Business e corrija a forma de pagamento (cartão válido ou saldo). Depois, clique em Atualizar conexão." },
}

/** O que mostrar na tela da conexão. Lista vazia: a Meta ainda não avisou nada. */
export function describeAccountHealth(health: AccountHealth | undefined | null, now = Date.now()): { tone: HealthTone; items: HealthItem[] } {
  const items: HealthItem[] = []
  const h = health ?? {}
  if (h.removed) items.push(h.removed.event === "deleted"
    ? { id: "removed", tone: "critical", title: "A conta do WhatsApp foi excluída", text: "A Meta avisou que a conta do WhatsApp Business (WABA) deixou de existir; nenhum envio vai funcionar.", action: "Crie uma conta nova na Meta e conecte o canal de novo." }
    : { id: "removed", tone: "critical", title: "A conta foi desconectada deste app", text: "A Meta avisou que a conta saiu da conexão com este app; os envios param.", action: "Reconecte o canal pelo botão “Trocar credencial” ou crie a conexão de novo." })
  if (h.disabled) {
    const disabled: Record<string, Omit<HealthItem, "id">> = {
      DISABLE: { tone: "critical", title: "A Meta desativou a conta", text: "Enquanto a conta estiver desativada nenhuma mensagem sai.", action: "Abra o Gerenciador de Negócios, veja o motivo na Central de Qualidade da conta e peça a revisão." },
      REINSTATE: { tone: "ok", title: "Conta reativada pela Meta", text: "A conta voltou a poder enviar mensagens." },
      SCHEDULE_FOR_DISABLE: { tone: "attention", title: "A Meta agendou a desativação da conta", text: "A conta ainda envia mensagens, mas vai ser desativada se nada mudar.", action: "Abra o Gerenciador de Negócios, veja o motivo na Central de Qualidade da conta e corrija antes da data." },
    }
    items.push({ id: "disabled", ...(disabled[h.disabled.state] ?? { tone: "info", title: "Estado da conta atualizado", text: `A Meta informou: ${h.disabled.state}.` }) })
  }
  if (h.review) {
    const review: Record<string, Omit<HealthItem, "id">> = {
      APPROVED: { tone: "ok", title: "Revisão da conta aprovada", text: "A Meta analisou a conta e liberou o uso." },
      REJECTED: { tone: "critical", title: "Revisão da conta reprovada", text: "A Meta não aprovou o uso da conta.", action: "Leia o motivo no Gerenciador de Negócios, corrija e peça uma nova revisão." },
      PENDING: { tone: "info", title: "Conta em revisão pela Meta", text: "A Meta está analisando a conta. Pode levar alguns dias.", action: "Não faça mudanças grandes na conta até sair o resultado." },
      DEFERRED: { tone: "attention", title: "Revisão da conta adiada", text: "A Meta adiou a decisão sobre a conta.", action: "Aguarde; se demorar, peça a revisão no Gerenciador de Negócios." },
    }
    items.push({ id: "review", ...(review[h.review.decision] ?? { tone: "info", title: "Revisão da conta atualizada", text: `A Meta informou: ${h.review.decision}.` }) })
  }
  // Lido na Meta ao conectar, trocar credencial ou atualizar (health_status do número): o que hoje impede ou limita o envio, por parte da conta.
  for (const block of (h.sending?.items ?? []) as SendBlock[]) {
    const where = sendingEntities[block.entity] ?? `Parte da conta na Meta (${block.entity})`
    const limited = block.status === "LIMITED"
    const errors = (block.errors ?? []).map(e => sendingErrors[e.code] ? `${sendingErrors[e.code].text} (erro ${e.code})` : `A Meta informou: ${e.description ?? "erro sem descrição"} (erro ${e.code})`)
    const known = (block.errors ?? []).map(e => sendingErrors[e.code]?.action).find(Boolean)
    const solution = (block.errors ?? []).map(e => e.solution).find(Boolean)
    items.push({ id: `sending-${block.entity}`, tone: limited ? "attention" : "critical", title: limited ? "A Meta limitou o envio de mensagens" : "A Meta bloqueou o envio de mensagens",
      text: `${where}: ${[...errors, ...(block.info ?? [])].join(" ") || (limited ? "envio com limitação." : "envio bloqueado.")}`,
      action: known ?? (solution ? `A Meta sugere: ${solution} Depois, clique em Atualizar conexão.` : "Abra o Gerenciador do WhatsApp na Meta, veja o aviso dessa parte da conta e corrija. Depois, clique em Atualizar conexão.") })
  }
  if (h.violation) items.push({ id: "violation", tone: "critical", title: "A Meta registrou uma violação das políticas",
    text: `Motivo informado: ${violationTypes[h.violation.type] ?? h.violation.type}.`, action: "Revise o conteúdo e a oferta das mensagens e peça uma revisão no Gerenciador de Negócios." })
  const restrictions: { type: string; expiresAt?: number }[] = h.restrictions?.items ?? []
  // Uma restrição com prazo já vencido deixou de valer: não aparece.
  for (const r of restrictions.filter(r => !r.expiresAt || r.expiresAt > now)) {
    const until = r.expiresAt ? ` Vale até ${day.format(r.expiresAt)}.` : ""
    items.push({ id: `restriction-${r.type}`, tone: "critical", title: "Restrição na conta", text: `${restrictionTypes[r.type] ?? `Restrição aplicada pela Meta (${r.type})`}.${until}`,
      action: "Veja o motivo na Central de Qualidade da conta, no Gerenciador de Negócios. Enquanto isso, responda só a quem escreveu para você." })
  }
  for (const [type, alert] of Object.entries<any>(h.alerts ?? {})) {
    const known = alertTypes[type]
    items.push({ id: `alert-${type}`, tone: alertTone[alert.severity] ?? "attention", title: known?.title ?? "Alerta da Meta sobre a conta",
      text: known?.text ?? (alert.description ? `A Meta informou: ${alert.description}` : "A Meta enviou um alerta sobre esta conta."), ...(known?.action ? { action: known.action } : { action: "Abra o Gerenciador de Negócios para ver os detalhes do alerta." }) })
  }
  if (h.quality) {
    const event = qualityEvents[h.quality.event] ?? { tone: "info" as const, title: "Aviso sobre o número", text: `A Meta informou: ${h.quality.event}.` }
    const limit = unlimited(h.quality.limit) ? "sem limite" : limitText(h.quality.limit)
    items.push({ id: "quality", ...event, text: limit && h.quality.event !== "THROUGHPUT_UPGRADE" ? `${event.text} Limite atual: ${limit === "sem limite" ? limit : `${limit} pessoas por dia`}.` : event.text })
  }
  if (h.limits) {
    const daily = unlimited(h.limits.maxDaily) ? "sem limite" : limitText(h.limits.maxDaily)
    const numbers = typeof h.limits.maxNumbers === "number" ? number.format(h.limits.maxNumbers) : null
    if (daily || numbers) items.push({ id: "limits", tone: "info", title: "Limite de mensagens da conta",
      text: [daily && (daily === "sem limite" ? "Você pode iniciar conversas com qualquer quantidade de pessoas por dia." : `Você pode iniciar conversa com até ${daily} pessoas diferentes por dia (em 24 horas).`),
        numbers && `A conta pode ter até ${numbers} números.`].filter(Boolean).join(" "),
      action: "Para subir o limite, verifique o negócio e envie com boa qualidade: só para quem pediu e com modelos úteis." })
  }
  const rank: Record<HealthTone, number> = { critical: 3, attention: 2, info: 1, ok: 0 }
  items.sort((a, b) => rank[b.tone] - rank[a.tone])
  return { tone: items.reduce<HealthTone>((worst, item) => rank[item.tone] > rank[worst] ? item.tone : worst, "ok"), items }
}

/** Limite diário de conversas novas para o cartão da conta ("100.000 conversas / 24 horas"); `null` enquanto a Meta não informou. */
export function dailyLimitLabel(health: AccountHealth | undefined | null): string | null {
  const raw = health?.limits?.maxDaily ?? health?.quality?.limit
  if (unlimited(raw)) return "Sem limite"
  const text = limitText(raw)
  return text ? `${text} conversas / 24 horas` : null
}
