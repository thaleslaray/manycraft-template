/**
 * Conflito entre palavras-chave: quais outras regras ativas da mesma conexão também pegariam as palavras de uma regra.
 * O casamento espelha `matchesKeyword` e a ordem espelha `firstKeywordMatch` (engine/src/flow/matcher.ts):
 * o teste keyword-conflicts.test.ts compara as duas implementações para garantir que continuam iguais.
 * Arquivo sem imports para rodar direto no node --test.
 */

/** Condições do painel (Palavras-chave) mais "any" (qualquer mensagem), que só existe no gatilho do editor. */
export type ConflictCondition = "contains" | "equals" | "word" | "starts" | "not_contains" | "thumbs_up" | "any"
export type ConflictRule = { condition: ConflictCondition; words: string[] }
/** Uma regra da lista de Palavras-chave (as do editor também aparecem lá), na ordem de prioridade do motor. */
export type ConflictCandidate = { id: string; name: string; channel: string; active: boolean; rules: ConflictRule[]
  audience?: "direct" | "group" | null; connection_id?: string | null; case_sensitive?: boolean }
export type KeywordConflict = { other: ConflictCandidate; sample: string; otherWins: boolean }

/** Regra do motor/editor (is, starts_with...) para a condição do painel. */
export const conditionFromEngineRule: Record<string, ConflictCondition> = {
  is: "equals", contains: "contains", starts_with: "starts", word_match: "word", does_not_contain: "not_contains", thumbs_up: "thumbs_up", any: "any",
}

const thumbsUpOnly = /^\s*\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?️?\s*$/u

/** Mesma normalização e mesmos modos de `matchesKeyword` no motor (sem acento; sem caixa salvo case_sensitive). */
export function ruleMatches(text: string, rule: ConflictRule, caseSensitive = false): boolean {
  if (rule.condition === "thumbs_up") return thumbsUpOnly.test(text)
  const normalize = (value: string) => {
    const plain = value.normalize("NFD").replace(/\p{M}/gu, "")
    return caseSensitive ? plain : plain.toLocaleLowerCase("pt-BR")
  }
  const input = normalize(text)
  const words = rule.words.map(normalize)
  if (rule.condition === "any") return true
  if (!words.length) return false
  if (rule.condition === "equals") return words.some(word => input.trim() === word.trim())
  if (rule.condition === "contains") return words.some(word => input.includes(word))
  if (rule.condition === "starts") return words.some(word => input.startsWith(word))
  if (rule.condition === "not_contains") return words.every(word => !input.includes(word))
  if (rule.condition === "word") return words.some(word => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, "u").test(input)
  })
  return false
}

/** Regra composta: todas as condições precisam casar (como o grupo no motor). Sem condições, não pega nada. */
export function candidateMatches(text: string, candidate: Pick<ConflictCandidate, "rules" | "case_sensitive">): boolean {
  return candidate.rules.length > 0 && candidate.rules.every(rule => ruleMatches(text, rule, candidate.case_sensitive))
}

/** Mensagens de exemplo: as palavras de cada regra (as desta primeiro) e, nas compostas, as combinações das duas condições. */
export function probeTexts(...candidates: Pick<ConflictCandidate, "rules">[]): string[] {
  const out: string[] = []
  for (const c of candidates) {
    const positive = c.rules.filter(r => r.condition !== "not_contains" && r.condition !== "thumbs_up" && r.condition !== "any")
    for (const r of positive) for (const w of r.words) if (w.trim()) out.push(w.trim())
    if (positive.length > 1) for (const a of positive[0].words) for (const b of positive[1].words) out.push(`${a.trim()} ${b.trim()}`)
    if (c.rules.some(r => r.condition === "thumbs_up")) out.push("👍")
  }
  return [...new Set(out)]
}

/** O motor só compara regras da mesma conexão (gatilho sem conexão vale para todas) e do mesmo público (direct ou grupo). */
function sameRoute(a: ConflictCandidate, b: ConflictCandidate) {
  if (a.channel !== b.channel || (a.audience ?? "direct") !== (b.audience ?? "direct")) return false
  return !a.connection_id || !b.connection_id || a.connection_id === b.connection_id
}

/**
 * Outras regras ativas que também pegariam as palavras de `target`, na ordem da lista.
 * `list` vem na ordem do motor (prioridade); `target` fora da lista é uma regra nova, que entra no fim.
 * `otherWins`: a outra vem antes e responde no lugar desta.
 */
export function findKeywordConflicts(target: ConflictCandidate, list: ConflictCandidate[]): KeywordConflict[] {
  const position = list.findIndex(row => row.id === target.id)
  const mine = position < 0 ? list.length : position
  const conflicts: KeywordConflict[] = []
  list.forEach((other, index) => {
    if (other.id === target.id || !other.active || !sameRoute(target, other)) return
    const sample = probeTexts(target, other).find(text => candidateMatches(text, target) && candidateMatches(text, other))
    if (sample !== undefined) conflicts.push({ other, sample, otherWins: index < mine })
  })
  return conflicts
}

/** Para a lista: a primeira regra ativa acima que pega uma mensagem desta (ela responde antes). */
export function shadowingRule(list: ConflictCandidate[], id: string): KeywordConflict | undefined {
  const row = list.find(r => r.id === id)
  if (!row || !row.active) return undefined
  return findKeywordConflicts(row, list).find(c => c.otherWins)
}

const verbs: Record<ConflictCondition, string> = {
  contains: "contém", equals: "é igual a", word: "tem a palavra", starts: "começa com", not_contains: "não contém", thumbs_up: "é curtir", any: "qualquer mensagem",
}
/** "contém “teste”" / "contém “a” ou “b” e começa com “c”". */
export function describeRules(rules: ConflictRule[]): string {
  return rules.map(r => r.condition === "thumbs_up" || r.condition === "any" ? verbs[r.condition]
    : `${verbs[r.condition]} ${r.words.map(w => `“${w}”`).join(" ou ")}`).join(" e ")
}

/** Texto do aviso, em pt-BR. */
export function conflictMessage(c: KeywordConflict): string {
  const other = `A regra “${c.other.name}” (${describeRules(c.other.rules)})`
  return c.otherWins
    ? `${other} também pega “${c.sample}” e vem antes, então ela responde no lugar desta.`
    : `${other} também pega “${c.sample}”, mas esta vem antes e passa na frente dela.`
}

/** Texto da marca na lista: a regra está encoberta pela outra acima. */
export function shadowMessage(c: KeywordConflict): string {
  return `Encoberta: a regra “${c.other.name}”, acima, também pega “${c.sample}” e responde antes desta.`
}
