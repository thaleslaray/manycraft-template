type Modelo = { name: string; description: string; category: string; trigger?: { kind: string } }

const normalize = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR")

/** "Todos" primeiro, depois as categorias na ordem em que aparecem, cada uma com a contagem. */
export function listCategories(templates: Modelo[]): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const t of templates) counts.set(t.category, (counts.get(t.category) ?? 0) + 1)
  return [{ name: "Todos", count: templates.length }, ...[...counts].map(([name, count]) => ({ name, count }))]
}

/** Filtra pelo objetivo (categoria), pela busca e, quando dado, pelo tipo de gatilho do modelo ("Por gatilho"). */
export function filterTemplates<T extends Modelo>(templates: T[], category: string, search: string, trigger = ""): T[] {
  const term = normalize(search.trim())
  return templates.filter(t => (category === "Todos" || t.category === category) && (!trigger || t.trigger?.kind === trigger) && normalize(`${t.name} ${t.description}`).includes(term))
}
