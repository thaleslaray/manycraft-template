/** Palavras do gatilho em etiquetas, só leitura. Lista vazia mostra o texto `empty` (ou nada, sem traço). */
export function WordTags({ label, words, empty }: { label: string; words: string[]; empty?: string }) {
  if (!words.length) return empty ? <p>{empty}</p> : null
  return (
    <ul role="list" aria-label={label} className="flex flex-wrap gap-2">
      {words.map(w => <li key={w} className="inline-flex h-8 items-center rounded-pill border border-border bg-surface px-3 text-sm">{w}</li>)}
    </ul>
  )
}
