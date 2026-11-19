import * as React from "react"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { conflictMessage, type KeywordConflict } from "@/data/keyword-conflicts"

/** Aviso de conflito entre palavras-chave: não bloqueia; oferece pausar a outra, subir esta (onde há ordem) ou manter. */
export function KeywordConflictNotice({ conflicts, busy, onPause, onRaise }: {
  conflicts: KeywordConflict[]; busy?: boolean
  onPause: (c: KeywordConflict) => void | Promise<unknown>
  /** Só na tela Palavras-chave, com a regra já salva. */
  onRaise?: () => void | Promise<unknown>
}) {
  const [kept, setKept] = React.useState<Set<string>>(new Set())
  const visible = conflicts.filter(c => !kept.has(`${c.other.id}|${c.sample}|${c.otherWins}`))
  // O aviso nasce no meio do formulário, muitas vezes abaixo da dobra: rola até ele quando aparece um conflito novo.
  const box = React.useRef<HTMLDivElement>(null)
  const signature = visible.map(c => `${c.other.id}|${c.sample}`).join(",")
  React.useEffect(() => { if (signature) box.current?.scrollIntoView?.({ block: "center", behavior: "smooth" }) }, [signature])
  if (!visible.length) return null
  return <div ref={box} className="space-y-2" data-testid="keyword-conflicts">
    {visible.map(c => <Banner key={`${c.other.id}|${c.sample}`} variant={c.otherWins ? "warning" : "info"}>
      <span className="break-words">{conflictMessage(c)}</span>
      <span className="mt-2 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void onPause(c)}>Pausar a outra</Button>
        {c.otherWins && onRaise ? <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void onRaise()}>Subir esta para o topo</Button> : null}
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setKept(old => new Set(old).add(`${c.other.id}|${c.sample}|${c.otherWins}`))}>Manter assim</Button>
      </span>
    </Banner>)}
  </div>
}
