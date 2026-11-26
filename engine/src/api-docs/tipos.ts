import type { z } from 'zod'

/** Uma rota documentada. `metodo` + `caminho` no formato do Hono (`/api/contacts/:id`), igual à lista liberada. */
export type EntradaCatalogo = {
  metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  caminho: string
  /** Uma frase em pt-BR: o que a rota faz. */
  resumo: string
  /** Schema zod do corpo JSON: o MESMO objeto que o handler usa para validar. */
  corpo?: z.ZodType
  /** Schema zod SÓ para o documento, no lugar de `corpo`, quando o handler aceita mais do que o formato útil (ex.: `graph: unknown`). Não muda a validação. */
  corpoDoc?: z.ZodType
  /** Schema zod da query string (objeto de strings). */
  query?: z.ZodType
  /** Corpo binário (o arquivo cru, com Content-Type do arquivo) em vez de JSON. */
  corpoBinario?: true
  /** Exemplo de corpo (opcional). */
  exemplo?: unknown
  /**
   * Schema zod SÓ para o documento: o formato da resposta de sucesso (JSON). O handler não valida a saída com ele; quem garante que ele não
   * mente é engine/test/api-docs-respostas.test.ts, que chama a rota e confere a resposta real. `z.object` fica aberto (campos não descritos
   * podem vir); descreva os campos estáveis e úteis.
   */
  resposta?: z.ZodType
  /** Tipo de conteúdo da resposta de sucesso quando não é JSON (ex.: `image/jpeg`). */
  respostaTipo?: string
  /** Rota que só existe em desenvolvimento: fica no catálogo (o check exige) mas não entra no documento. */
  soDesenvolvimento?: true
}

/** Um arquivo por área (a 2ª parte do caminho: `/api/<área>/...`). */
export type AreaCatalogo = {
  area: string
  /** Nome legível em pt-BR: vira a tag do documento. */
  nome: string
  /** Uma frase curta sobre a área (descrição da tag). */
  descricao: string
  entradas: EntradaCatalogo[]
}
