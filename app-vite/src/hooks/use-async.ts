import * as React from "react"

type State<T> = { key: string; base: string; cache: string | null; data?: T; error?: Error } | null

/**
 * Último dado bom das telas de leitura que pedem cache (`opts.cache`): voltar à tela mostra esse dado
 * na hora e atualiza em segundo plano, em vez de esqueleto a cada visita.
 * `opts.cache` é a identidade do dado: única por chamada e com tudo o que muda o resultado (espaço, filtros),
 * sem contadores de recarga.
 * Formulário que copia o dado para um estado local usa hooks/use-draft (acompanha a revalidação só enquanto ninguém mexeu).
 * Gravações descartam o cache do que mudam (data/api + staleAfterWrite em data/screen-keys).
 * Vive só na memória da aba: sair da conta recarrega a página ou chama clearAsyncCache.
 */
const cache = new Map<string, unknown>()
/** Quando cada identidade foi gravada: aquecimento só repete depois de PRIME_FRESH_MS. */
const savedAt = new Map<string, number>()
/** Aquecimentos em voo: a tela que monta antes da resposta pega a mesma promessa em vez de pedir de novo. */
const priming = new Map<string, Promise<unknown>>()
const PRIME_FRESH_MS = 30_000
/** Ordem dos pedidos e dos descartes: leitura que começou antes de um descarte não grava (traria o estado de antes da gravação). */
let sequence = 0
const forgotten = new Map<string, number>()
export function clearAsyncCache() { cache.clear(); savedAt.clear(); priming.clear(); forgotten.clear() }
function save(id: string, data: unknown, started: number, at = Date.now()) {
  for (const [prefix, when] of forgotten) if (when > started && id.startsWith(prefix)) return
  cache.set(id, data); savedAt.set(id, at)
}

/**
 * Descarta o cache de toda identidade que começa com `prefix` (ex.: "automation-library|" = todas as variações de filtro),
 * os aquecimentos em voo dela e o que leituras já em andamento gravariam. Chamado depois de uma gravação que muda o dado
 * (data/api), antes de a tela recarregar: ela nunca pinta um dado que sabe estar velho.
 */
export function forgetAsync(prefix: string) {
  forgotten.set(prefix, ++sequence)
  for (const map of [cache, savedAt, priming]) for (const id of [...map.keys()]) if (id.startsWith(prefix)) map.delete(id)
}

/**
 * Aquece o cache de uma tela antes de ela montar (passar o mouse no menu): grava em `id` o que `fn` devolver,
 * com a MESMA identidade que a tela passa em `opts.cache`, senão o pedido é desperdiçado.
 * Não faz nada se o dado tem menos de 30 s ou já há aquecimento em voo. Erro é engolido: a tela pede de novo ao montar.
 */
export function primeAsync<T>(id: string, fn: () => Promise<T>): Promise<void> {
  if (priming.has(id)) return Promise.resolve()
  const at = savedAt.get(id)
  if (at !== undefined && cache.has(id) && Date.now() - at < PRIME_FRESH_MS) return Promise.resolve()
  const started = Date.now(), order = ++sequence
  const request = Promise.resolve().then(fn)
  priming.set(id, request)
  return request.then(
    // Uma leitura mais nova (a da própria tela) pode ter chegado antes: não a troca por esta, mais velha.
    data => { if ((savedAt.get(id) ?? 0) <= started) save(id, data, order, started) },
    () => undefined,
  ).finally(() => { if (priming.get(id) === request) priming.delete(id) })
}

/**
 * Carrega dados assíncronos. `loading` é derivado (a chave da última resposta
 * difere da chave atual), então nada de setState síncrono dentro do efeito.
 * Para ver os estados sem mexer no código: ?simular=erro ou ?simular=lento.
 */
export function useAsync<T>(fn: () => Promise<T>, key: string, opts?: { cache: string }) {
  const [res, setRes] = React.useState<State<T>>(null)
  const [nonce, setNonce] = React.useState(0)
  const fnRef = React.useRef(fn)
  React.useEffect(() => {
    fnRef.current = fn
  })
  const fullKey = `${key}#${nonce}`
  const cacheKey = opts?.cache ?? null

  React.useEffect(() => {
    let cancelled = false
    const sim = new URLSearchParams(window.location.search).get("simular")
    const started = ++sequence
    const run = async () => {
      if (sim === "lento") await new Promise((r) => setTimeout(r, 4000))
      if (sim === "erro") throw new Error("Falha simulada.")
      // Aquecimento ainda em voo para esta identidade: a primeira leitura reaproveita a resposta dele (se ele falhar, pede de novo).
      const warming = cacheKey && nonce === 0 ? priming.get(cacheKey) as Promise<T> | undefined : undefined
      return warming ? warming.catch(() => fnRef.current()) : fnRef.current()
    }
    run().then(
      (data) => { if (cacheKey) save(cacheKey, data, started); if (!cancelled) setRes({ key: fullKey, base: key, cache: cacheKey, data }) },
      (error: Error) => !cancelled && setRes({ key: fullKey, base: key, cache: cacheKey, error })
    )
    return () => {
      cancelled = true
    }
  }, [fullKey, key, cacheKey, nonce])

  const settled = res?.key === fullKey
  // Recarga (reload) de tela com cache cujo dado foi descartado por uma gravação: segue mostrando a última resposta desta tela, como antes do descarte.
  const cached = cacheKey && cache.has(cacheKey) ? (cache.get(cacheKey) as T) : cacheKey && res?.cache === cacheKey && res.base === key ? res.data : undefined
  return {
    data: settled ? res?.data : cached,
    /** Último dado bom, mesmo enquanto recarrega (evita piscar a tela). */
    stale: res?.data ?? cached,
    error: settled ? res?.error : undefined,
    loading: !settled && cached === undefined,
    reload: () => setNonce((n) => n + 1),
  }
}
