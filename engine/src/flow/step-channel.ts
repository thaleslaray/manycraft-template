/** Um passo de mensagem pertence a um canal. Sem canal (fluxo antigo) ou "pending" (canal a escolher) o passo vale para todos. */
export function channelMismatch(stepChannel: unknown, runChannel: string): boolean {
  return typeof stepChannel === 'string' && stepChannel !== 'pending' && stepChannel !== runChannel
}
