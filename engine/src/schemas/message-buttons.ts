/** Botões de uma mensagem: o limite vem da ficha de cada conexão, nunca do nome do canal. */
export const BUTTON_DEFAULT_MAX = 3
export type ButtonProfile = { buttons: { maxPerMessage: number } }

/** O menor limite entre as conexões do gatilho; sem conexão escolhida vale o padrão do ManyChat (3). */
export function buttonLimit(profiles: ButtonProfile[]): number {
  return profiles.length ? Math.min(...profiles.map(p => p.buttons.maxPerMessage)) : BUTTON_DEFAULT_MAX
}

export function buttonsError(blocks: { kind?: unknown }[], profiles: ButtonProfile[]): string | undefined {
  const count = blocks.filter(b => b.kind === 'button').length
  if (!count) return
  const max = buttonLimit(profiles)
  if (max <= 0) return 'Esta conexão não aceita botões.'
  if (count > max) return `Use até ${max} botões por mensagem nesta conexão.`
}
