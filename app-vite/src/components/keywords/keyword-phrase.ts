const phrases: Record<string, string> = {
  contains: "contém estas palavras-chave:",
  not_contains: "não contém estas palavras-chave:",
  equals: "é igual a uma destas palavras-chave:",
  starts: "começa com uma destas palavras-chave:",
  word: "contém uma destas palavras inteiras:",
  thumbs_up: "é só o polegar para cima",
}

/** Frase que antecede as etiquetas de palavras na caixa de uma condição. */
export const conditionPhrase = (condition: string) => phrases[condition] ?? "combina com:"

/** Regras de palavra-chave que disparam a automação dada, na ordem da lista. */
export const rulesBoundTo = <T extends { automation_id: string }>(rows: T[], automationId: string) => rows.filter(r => r.automation_id === automationId)
