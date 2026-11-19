export type TagOption = { kind: "existing" | "create"; id: string; label: string; name: string }

const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()

/** Opções do "Adicionar tag": as tags que o contato ainda não tem e batem com a busca, mais "Criar tag «nome»" quando não existe uma com o nome digitado. */
export function tagOptions(tags: { id: string; name: string }[], taken: string[], query: string): TagOption[] {
  const q = fold(query)
  const free = tags.filter(t => !taken.includes(t.id))
  const shown: TagOption[] = free.filter(t => !q || fold(t.name).includes(q)).map(t => ({ kind: "existing", id: t.id, label: t.name, name: t.name }))
  const typed = query.trim()
  if (typed && !tags.some(t => fold(t.name) === q)) shown.push({ kind: "create", id: "__create", label: `Criar tag «${typed}»`, name: typed })
  return shown
}

export function moveTagActive(index: number, length: number, key: string): number {
  if (length <= 0) return 0
  if (key === "ArrowDown") return Math.min(index + 1, length - 1)
  if (key === "ArrowUp") return Math.max(index - 1, 0)
  if (key === "Home") return 0
  if (key === "End") return length - 1
  return index
}
