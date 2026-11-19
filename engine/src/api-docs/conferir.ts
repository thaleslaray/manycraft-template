// Confere o catálogo contra as rotas reais (etapa do npm run check, via scripts/api-inventario.mjs). Função pura: devolve os erros.
// Exige catálogo completo: toda rota liberada tem entrada, sem lista de pendências.
import type { AreaCatalogo } from './tipos'

export const areaDaRota = (rota: string) => rota.split(' ')[1]!.split('/')[2]!

export function conferirCatalogo({ liberadas, areas, rotasV1, v1 }: {
  /** "MÉTODO /caminho" liberadas para a chave (API_KEY_ALLOWED). */
  liberadas: readonly string[]
  areas: AreaCatalogo[]
  /** Rotas montadas em /api/public/v1. */
  rotasV1: readonly string[]
  v1: AreaCatalogo
}): string[] {
  const erros: string[] = []
  const lib = new Set(liberadas)
  const documentadas = new Set<string>()
  for (const area of areas) {
    if (!area.nome?.trim()) erros.push(`área sem nome legível: ${area.area}`)
    if (!area.descricao?.trim()) erros.push(`área sem descrição: ${area.area}`)
    for (const e of area.entradas) {
      const rota = `${e.metodo} ${e.caminho}`
      if (documentadas.has(rota)) erros.push(`entrada repetida: ${rota}`)
      documentadas.add(rota)
      if (lib.has(rota) && areaDaRota(rota) !== area.area) erros.push(`entrada na área errada: ${rota} está em ${area.area} (área ${areaDaRota(rota)})`)
    }
  }
  for (const rota of liberadas) if (!documentadas.has(rota)) erros.push(`rota liberada sem catálogo: ${rota} (área ${areaDaRota(rota)})`)
  for (const rota of documentadas) if (!lib.has(rota)) erros.push(`entrada órfã (rota não liberada): ${rota}`)
  const montadasV1 = new Set(rotasV1), docV1 = new Set(v1.entradas.map(e => `${e.metodo} ${e.caminho}`))
  for (const r of rotasV1) if (!docV1.has(r)) erros.push(`rota v1 sem catálogo: ${r}`)
  for (const r of docV1) if (!montadasV1.has(r)) erros.push(`entrada v1 órfã: ${r}`)
  return erros
}
