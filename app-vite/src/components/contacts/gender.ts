/** O gênero chega dos canais em inglês ("female"), do painel antigo como "f"; a tela sempre mostra pt-BR. */
const known: Record<string, string> = {
  female: "Feminino", f: "Feminino", feminino: "Feminino",
  male: "Masculino", m: "Masculino", masculino: "Masculino",
  other: "Outro", outro: "Outro", non_binary: "Outro", nonbinary: "Outro", "non-binary": "Outro",
}

export function genderLabel(value: string | null | undefined): string {
  if (!value) return ""
  return known[value.trim().toLowerCase()] ?? value
}

/** Forma gravada pelo painel (a mesma que os canais e o filtro usam). */
export function genderValue(value: string | null | undefined): "female" | "male" | "other" | null {
  const label = genderLabel(value)
  return label === "Feminino" ? "female" : label === "Masculino" ? "male" : label === "Outro" ? "other" : null
}

export const genderOptions = [
  { id: "female", name: "Feminino" },
  { id: "male", name: "Masculino" },
  { id: "other", name: "Outro" },
]
