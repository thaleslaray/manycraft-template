/** Graph API falsa só para a Media API (GET /{media-id} e o download pelo link), nos formatos de
 * replica/contratos/meta-whatsapp/inventario.md: a consulta devolve {messaging_product,url,mime_type,sha256,file_size,id}; o link vale 5 minutos e pede o mesmo token. */
export type MidiaFalsa = { mime: string; bytes: Uint8Array }
export function graphMidiaFalsa(token = 'TESTONLY') {
  const midias = new Map<string, MidiaFalsa>()
  const consultas: string[] = []
  const downloads: { url: string; autorizacao: string | null }[] = []
  /** Falhas na ordem: cada uma vale para a próxima chamada que casar. */
  const falhas: { quando: (url: URL) => boolean; resposta: () => Response | Promise<Response>; vezes: number }[] = []
  let links = 0
  const erro = (status: number, code: number, extra: object = {}) => Response.json({ error: { message: 'erro de teste', type: 'OAuthException', code, ...extra } }, { status })
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const autorizacao = new Headers(init?.headers).get('authorization')
    const falha = falhas.find(f => f.quando(url))
    if (falha) { if (--falha.vezes <= 0) falhas.splice(falhas.indexOf(falha), 1); return falha.resposta() }
    if (autorizacao !== `Bearer ${token}`) return erro(401, 190, { error_subcode: 463 })
    if (url.host === 'lookaside.fbsbx.com') {
      downloads.push({ url: url.href, autorizacao })
      const midia = midias.get(url.searchParams.get('mid') ?? '')
      if (!midia || url.searchParams.get('exp') !== String(links)) return new Response('expired', { status: 404 })
      return new Response(midia.bytes, { headers: { 'content-type': midia.mime } })
    }
    const m = url.pathname.match(/^\/v\d+\.\d+\/([^/]+)$/)
    if (url.host === 'graph.facebook.com' && m) {
      consultas.push(m[1]!)
      const midia = midias.get(m[1]!)
      if (!midia) return erro(400, 100, { error_subcode: 33, message: 'Unsupported get request. Object does not exist' })
      links++
      return Response.json({ messaging_product: 'whatsapp', url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${m[1]}&exp=${links}`, mime_type: midia.mime, sha256: 'x', file_size: String(midia.bytes.byteLength), id: m[1] })
    }
    return erro(400, 100)
  }) as typeof fetch
  return { fetch: fetcher, midias, consultas, downloads, falhas,
    falhar: (quando: (url: URL) => boolean, resposta: () => Response | Promise<Response>, vezes = 1) => { falhas.push({ quando, resposta, vezes }) } }
}
export const pdfFalso = () => new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n'), ...new Array(40).fill(7)])
export const pngFalso = () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(40).fill(1)])
/** Chamada de rede que o teste não previu: falha alto em vez de sair para a internet. */
export const realFetchNotAllowed = (): never => { throw new Error('chamada de rede inesperada no teste') }
