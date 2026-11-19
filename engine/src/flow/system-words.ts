/** Fixed whole-message commands. They live outside custom keywords. */
export function systemWord(text: string | undefined): 'system_opt_in' | 'system_opt_out' | undefined {
  const word = text?.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  if (word && ['parar', 'sair', 'stop', 'unsubscribe'].includes(word)) return 'system_opt_out'
  if (word && ['voltar', 'comecar', 'start', '/start', 'subscribe'].includes(word)) return 'system_opt_in'
}
