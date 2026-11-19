/** Mídia hospedada pela ManyChat: é a única que o importador copia para o nosso armazenamento. */
export function isManychatMediaUrl(value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return /(^|\.)manychat\.com$/.test(host) || /(^|\.)manybot\.io$/.test(host) || /^manybot[\w-]*\.s3[\w.-]*\.amazonaws\.com$/.test(host)
}

export type MediaCopy = { mediaId: string; url: string; mime: string; size: number }
/** Resultado de copiar um endereço: o arquivo guardado, ou o motivo da falha. `undefined` = não houve tentativa. */
export type MediaResolver = (url: string) => MediaCopy | { error: string } | undefined
