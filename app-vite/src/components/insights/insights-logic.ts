/** Passo "redondo" (1, 2, 3, 4, 5, 6, 8 ou 10 vezes uma potência de dez) para o eixo do gráfico ter `linhas` intervalos. */
export function passoDoEixo(max: number, linhas = 7) {
  const bruto = Math.max(max / linhas, 1)
  const potencia = 10 ** Math.floor(Math.log10(bruto))
  return [1, 2, 3, 4, 5, 6, 8, 10].map(m => m * potencia).find(p => p >= bruto) ?? 10 * potencia
}

/** Rótulo curto do eixo: 70000 vira "70 mil"; valores que não são milhares exatos aparecem por extenso. */
export const rotuloDoEixo = (v: number) => v >= 1000 && v % 1000 === 0 ? `${(v / 1000).toLocaleString('pt-BR')} mil` : v.toLocaleString('pt-BR')
