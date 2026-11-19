/**
 * Registra uma falha de tarefa de fundo (cron, fila, caminho rápido) sem engolir a causa.
 * Só o rótulo, o nome e a mensagem do erro (cortada): nunca payload, ids de contato ou pilha.
 */
export function errorFields(error: unknown): { error: string; message: string } {
  if (error instanceof Error) return { error: error.name || 'Error', message: error.message.slice(0, 300) }
  return { error: typeof error, message: String(error).slice(0, 300) }
}

export function logTaskError(event: string, error: unknown): void {
  console.error(JSON.stringify({ event, ...errorFields(error) }))
}
