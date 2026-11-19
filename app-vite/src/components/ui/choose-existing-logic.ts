export type Choice = { id: string; label: string; hint?: string }

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
}

/** Busca sem acento nem caixa; texto vazio devolve tudo. */
export function filterChoices<T extends Choice>(items: T[], query: string): T[] {
  const q = fold(query)
  return q ? items.filter(item => fold(item.label).includes(q)) : items
}

/** Posição destacada depois de uma tecla de navegação; não passa das pontas. */
export function moveActive(index: number, length: number, key: string): number {
  if (length <= 0) return 0
  if (key === "ArrowDown") return Math.min(index + 1, length - 1)
  if (key === "ArrowUp") return Math.max(index - 1, 0)
  if (key === "Home") return 0
  if (key === "End") return length - 1
  return index
}
