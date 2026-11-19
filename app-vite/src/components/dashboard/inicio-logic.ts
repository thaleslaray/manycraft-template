import type { DashboardSummary, ReportChannel } from "@/data/dashboard"

const ordem: [Exclude<ReportChannel, "all">, string][] = [["telegram", "Telegram"], ["whatsapp", "WhatsApp"], ["instagram", "Instagram"], ["email", "E-mail"], ["tiktok", "TikTok"]]

/** Abas do Início: "Todos os canais" e uma por tipo de canal conectado (como no original), na ordem fixa. */
export function abasDeCanal(channels: DashboardSummary["channels"]): { value: ReportChannel; label: string }[] {
  const tipos = new Set((channels ?? []).filter(c => c.status === "connected").map(c => c.type))
  return [{ value: "all", label: "Todos os canais" }, ...ordem.filter(([value]) => tipos.has(value)).map(([value, label]) => ({ value, label }))]
}

/** Cartão "Primeiros passos": até três linhas, mais a contagem do checklist inteiro; `pendente` diz se o cartão aparece (some com tudo feito). */
export function proximosPassos(steps: DashboardSummary["checklist"]) {
  const todos = steps ?? []
  const ordenados = [...todos.filter(s => !s.done), ...todos.filter(s => s.done)]
  const concluidos = todos.filter(s => s.done).length
  return { linhas: ordenados.slice(0, 3), concluidos, total: todos.length, pendente: concluidos < todos.length }
}

/** O rótulo que acompanha uma contagem: "1 canal conectado", "2 canais conectados", "0 canais conectados". */
export const rotuloDaContagem = (n: number, singular: string, plural: string) => n === 1 ? singular : plural
