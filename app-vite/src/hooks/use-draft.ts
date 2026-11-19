import * as React from "react"

const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * Valor de formulário que nasce do dado da tela, que pode vir do cache (useAsync) e ser trocado pela revalidação.
 * Regra: enquanto o valor é igual ao dado de origem (ninguém mexeu), um dado novo o substitui; editado, fica o que a pessoa
 * escolheu. Depois de salvar, a recarga traz um dado igual ao valor e o formulário volta a acompanhar o dado.
 */
export function useDraft<T>(source: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = React.useState({ source, value: source })
  let current = state
  if (!sameJson(state.source, source)) {
    current = { source, value: sameJson(state.value, state.source) ? source : state.value }
    setState(current)
  }
  const set = React.useCallback((next: React.SetStateAction<T>) => setState(s => ({ ...s, value: typeof next === "function" ? (next as (v: T) => T)(s.value) : next })), [])
  return [current.value, set]
}

/**
 * Chave de um formulário não controlado (`defaultValue`) que nasce do dado: muda, e o formulário remonta com o dado novo,
 * só enquanto ninguém mexeu nele. `touch` vai no `onChange` do formulário; `release` depois de salvar (ou ao fechar o diálogo),
 * para o próximo dado voltar a valer.
 */
export function useFormKey(source: string) {
  const [state, setState] = React.useState({ key: source, touched: false })
  let current = state
  if (state.key !== source && !state.touched) {
    current = { key: source, touched: false }
    setState(current)
  }
  const touch = React.useCallback(() => setState(s => s.touched ? s : { ...s, touched: true }), [])
  const release = React.useCallback(() => setState(s => s.touched ? { ...s, touched: false } : s), [])
  return { key: current.key, touch, release }
}
