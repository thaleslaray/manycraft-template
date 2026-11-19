// Telefone em E.164 (só dígitos, com o código do país): validação por país.
// Para os países mais comuns, o total de dígitos precisa bater; nos demais vale a regra geral da E.164 (8 a 15 dígitos).
// Não confere se o número existe na operadora: isso exige consulta paga a um provedor.

type CountryRule = { code: string; name: string; lengths: number[]; check?: (national: string) => boolean }
const RULES: CountryRule[] = [
  // Brasil: DDD de 2 dígitos (11 a 99) e 8 dígitos (fixo) ou 9 começando por 9 (celular).
  { code: '55', name: 'Brasil', lengths: [12, 13], check: n => /^[1-9][1-9]/.test(n) && (n.length === 10 || n[2] === '9') },
  { code: '1', name: 'Estados Unidos e Canadá', lengths: [11], check: n => /^[2-9]\d{2}[2-9]/.test(n) },
  { code: '351', name: 'Portugal', lengths: [12], check: n => /^[29]/.test(n) },
  { code: '54', name: 'Argentina', lengths: [12, 13] }, { code: '56', name: 'Chile', lengths: [11] },
  { code: '57', name: 'Colômbia', lengths: [12] }, { code: '52', name: 'México', lengths: [12, 13] },
  { code: '598', name: 'Uruguai', lengths: [11] }, { code: '595', name: 'Paraguai', lengths: [12] },
  { code: '51', name: 'Peru', lengths: [11] }, { code: '34', name: 'Espanha', lengths: [11] },
  { code: '44', name: 'Reino Unido', lengths: [12] }, { code: '49', name: 'Alemanha', lengths: [11, 12, 13] },
  { code: '33', name: 'França', lengths: [11] }, { code: '39', name: 'Itália', lengths: [11, 12, 13] },
]

/** País do telefone pelo código mais longo que casar (ou null). */
export function phoneCountry(digits: string): CountryRule | null {
  return [...RULES].sort((a, b) => b.code.length - a.code.length).find(rule => digits.startsWith(rule.code)) ?? null
}

/** Motivo da recusa, ou null quando o telefone serve. Recebe só dígitos. */
export function phoneProblem(digits: string): string | null {
  if (!/^[1-9]\d{7,14}$/.test(digits)) return 'Use o telefone com código do país e DDD, só números (8 a 15 dígitos).'
  const country = phoneCountry(digits)
  if (!country) return null
  const national = digits.slice(country.code.length)
  if (!country.lengths.includes(digits.length) || (country.check && !country.check(national)))
    return `Telefone inválido para ${country.name}: confira o DDD e a quantidade de dígitos.`
  return null
}

/** E-mail com um único @, usuário e domínio com ponto. */
export function emailProblem(email: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? null : 'E-mail inválido: use o formato nome@dominio.com.'
}
