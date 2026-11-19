// GET /api/docs (página do Scalar) e GET /api/docs/openapi.json: públicos, montados antes do middleware de sessão.
import { Hono } from 'hono'
import { API_KEY_ALLOWED } from '../api-rotas-liberadas'
import { AREAS, v1 } from './catalogo'
import { gerarOpenApi } from './gerar'

export const SCALAR_URL = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.80.0'
// Sem a barra do Scalar (deploy, SDK pago, "Developer Tools") nem o "Ask AI", que manda o documento para o serviço deles.
// O botão de testar pedido fica: é o que quem integra usa. Exemplo de código abre em curl.
export const SCALAR_CONFIG = JSON.stringify({ showDeveloperTools: 'never', agent: { disabled: true }, defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' } })
let documento: string | null = null
/** Só entra o que a chave abre: entrada de rota fora da lista liberada nunca aparece (o check já recusa, aqui é a segunda trava). */
export function documentoOpenApi() {
  const liberadas = new Set(API_KEY_ALLOWED)
  return documento ??= JSON.stringify(gerarOpenApi({
    areas: AREAS.map(a => ({ ...a, entradas: a.entradas.filter(e => liberadas.has(`${e.metodo} ${e.caminho}`)) })), v1,
  }))
}

const pagina = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Documentação da API</title></head>
<body>
<script id="api-reference" data-url="/api/docs/openapi.json" data-configuration='${SCALAR_CONFIG}'></script>
<script src="${SCALAR_URL}"></script>
</body>
</html>`

export const apiDocs = new Hono()
apiDocs.get('/', c => {
  // Só esta página libera o CDN do Scalar; o resto do motor segue sem script de fora.
  c.header('Content-Security-Policy', "default-src 'none'; script-src https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src https://cdn.jsdelivr.net https://fonts.scalar.com https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
  return c.html(pagina)
})
apiDocs.get('/openapi.json', c => {
  c.header('Cache-Control', 'public, max-age=300')
  return c.body(documentoOpenApi(), 200, { 'Content-Type': 'application/json; charset=utf-8' })
})
