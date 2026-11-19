/** Formulário "Novo gatilho" aberto no editor: Publicar consulta isto para criar o gatilho antes de publicar. */
export type PendingTrigger = { missing: string; submit: () => Promise<boolean> }
let current: PendingTrigger | null = null
export function setPendingTrigger(p: PendingTrigger | null) { current = p }
export function getPendingTrigger() { return current }
