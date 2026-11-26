/**
 * Nome de quem usa o painel. Conta criada pela entrada por código nasce sem nome (`name: ""`):
 * onde o painel mostra a pessoa, o nome vazio cai para o e-mail.
 */
export function nomeOuEmail(nome: string | null | undefined, email: string): string {
  return nome?.trim() || email
}

/** Primeiro nome para a saudação. O motor manda o e-mail no lugar do nome vazio: e-mail não vira "Olá, fulano@…!". */
export function primeiroNome(nome: string | null | undefined): string | undefined {
  const primeiro = nome?.trim().split(/\s+/)[0]
  return primeiro && !primeiro.includes('@') ? primeiro : undefined
}
