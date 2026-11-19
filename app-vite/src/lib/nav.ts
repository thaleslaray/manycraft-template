import { Home, Users, Zap, Inbox, Megaphone, ChartNoAxesCombined, Settings, type LucideIcon } from "lucide-react"

export type NavItem = { href: string; label: string; icon: LucideIcon }

/** href relativo ao workspace (sem barra inicial). */
export const mainNav: NavItem[] = [
  { href: "dashboard", label: "Início", icon: Home },
  { href: "contacts", label: "Contatos", icon: Users },
  { href: "automations", label: "Automação", icon: Zap },
  { href: "inbox", label: "Caixa de entrada", icon: Inbox },
  { href: "broadcasts", label: "Transmissões", icon: Megaphone },
  { href: "insights", label: "Insights", icon: ChartNoAxesCombined },
  { href: "settings", label: "Configurações", icon: Settings },
]

/** Áreas que o motor só mostra a quem lê automações (o atendente não lê). */
export const automationAreas = ["dashboard", "automations", "broadcasts", "insights"]

/** Rótulos de segmento de rota para o breadcrumb. */
export const segmentLabels: Record<string, string> = {
  dashboard: "Início",
  installed: "Modelos instalados",
  agency: "Agência",
  compliance: "Conformidade",
  topics: "Tópicos de notificação",
  apps: "Apps",
  notices: "Notificações",
  contacts: "Contatos",
  automations: "Automação",
  basic: "Básico",
  keywords: "Palavras-chave",
  sequences: "Sequências",
  rules: "Regras",
  inbox: "Caixa de entrada",
  broadcasts: "Transmissões",
  insights: "Insights",
  settings: "Configurações",
  channels: "Canais",
  "message-templates": "Modelos de mensagem",
  email: "E-mail",
  design: "Design",
  fields: "Campos",
  tags: "Tags",
  team: "Equipe",
  api: "API",
  integrations: "Integrações",
  logs: "Registros",
  "email-rules": "Regras de e-mail",
  triggers: "Gatilhos",
}
