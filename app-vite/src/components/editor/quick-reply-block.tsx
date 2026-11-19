import * as React from "react"
import type { Connection } from "@/data/connections"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  QUICK_REPLY_ATTEMPTS_MAX, QUICK_REPLY_WINDOW_MS, SKIP_LABEL, durationMs, isQuickReply, quickReplyLimits, quickRepliesError,
  type QuickReplyBlock, type QuickReplyLimits, type QuickReplyProfile,
} from "../../../../engine/src/schemas/message-quick-replies"
export { isQuickReply, quickRepliesError, SKIP_LABEL, type QuickReplyBlock }

const noButtons = { types: [], maxPerMessage: 0, titleMax: 0, payloadMaxBytes: 0 }
export const quickReplyProfiles = (connections: Connection[]): QuickReplyProfile[] =>
  connections.map(c => ({ quickReplies: c.profile?.quickReplies, buttons: c.profile?.buttons ?? noButtons }))
/** O menor limite entre as conexões do gatilho; null quando alguma não tem como receber o toque. */
export function sharedQuickReplyLimits(connections: Connection[]): QuickReplyLimits | null {
  const limits = quickReplyProfiles(connections).map(quickReplyLimits)
  if (!limits.length || limits.some(l => !l)) return null
  return { max: Math.min(...limits.map(l => l!.max)), titleMax: Math.min(...limits.map(l => l!.titleMax)), native: limits.every(l => l!.native) }
}

type Duration = { value: number; unit: "seconds" | "minutes" | "hours" | "days" }
const waits: { id: string; label: string; value: Duration }[] = [
  { id: "5m", label: "5 minutos", value: { value: 5, unit: "minutes" } },
  { id: "30m", label: "30 minutos", value: { value: 30, unit: "minutes" } },
  { id: "1h", label: "1 hora", value: { value: 1, unit: "hours" } },
  { id: "6h", label: "6 horas", value: { value: 6, unit: "hours" } },
  { id: "12h", label: "12 horas", value: { value: 12, unit: "hours" } },
  { id: "24h", label: "24 horas", value: { value: 24, unit: "hours" } },
]
const waitOf = (d?: Duration) => d ? waits.find(w => durationMs(w.value) === durationMs(d))?.id ?? "custom" : "auto"

export function QuickReplyEditor({ block, index, limits, disabled, onChange }: { block: QuickReplyBlock; index: number; limits: QuickReplyLimits | null; disabled: boolean; onChange: (b: QuickReplyBlock) => void }) {
  const id = React.useId()
  const max = limits?.titleMax ?? 20
  const over = [...block.label].length > max
  if (block.skip) return <p className="text-sm text-text-muted">Quem não quiser escolher toca em “{SKIP_LABEL}”. Sem ligação própria, o fluxo segue pelo próximo passo.</p>
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Título da resposta rápida {index}</Label>
      <Input id={id} value={block.label} disabled={disabled} aria-invalid={over || undefined} onChange={e => onChange({ ...block, label: e.target.value })} />
      <p className={over ? "text-right text-xs text-danger" : "text-right text-xs text-text-muted"} aria-live="polite">{[...block.label].length} / {max}</p>
    </div>
  )
}

/** Quanto esperar por toque e quantas vezes reenviar as opções antes de seguir pelo próximo passo. */
export function QuickReplySettings({ config, disabled, onChange }: { config: Record<string, unknown>; disabled: boolean; onChange: (patch: Record<string, unknown>) => void }) {
  const id = React.useId()
  const attempts = typeof config.reply_attempts === "number" ? config.reply_attempts : 1
  const timeout = config.click_timeout as Duration | undefined
  const fits = (w: { value: Duration }, n: number) => durationMs(w.value) * n <= QUICK_REPLY_WINDOW_MS
  const chosen = waitOf(timeout)
  return (
    <section aria-label="Retomada sem toque" className="space-y-3 rounded-lg border border-border p-3">
      <h3 className="text-xs font-semibold text-text-muted">Se a pessoa não tocar</h3>
      <div className="space-y-1">
        <Label htmlFor={`${id}-wait`}>Esperar por toque (por tentativa)</Label>
        <Select value={chosen} disabled={disabled} onValueChange={v => onChange({ click_timeout: v === "auto" ? undefined : waits.find(w => w.id === v)!.value })}>
          <SelectTrigger id={`${id}-wait`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">24 horas divididas entre as tentativas</SelectItem>
            {waits.map(w => <SelectItem key={w.id} value={w.id} disabled={!fits(w, attempts)}>{w.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-attempts`}>Tentativas (1 a {QUICK_REPLY_ATTEMPTS_MAX})</Label>
        <Input id={`${id}-attempts`} type="number" min={1} max={QUICK_REPLY_ATTEMPTS_MAX} value={attempts} disabled={disabled}
          onChange={e => {
            const n = Math.min(QUICK_REPLY_ATTEMPTS_MAX, Math.max(1, Math.round(Number(e.target.value) || 1)))
            const keep = timeout && durationMs(timeout) * n <= QUICK_REPLY_WINDOW_MS ? timeout : undefined
            onChange({ reply_attempts: n === 1 ? undefined : n, click_timeout: keep })
          }} />
      </div>
      <p className="text-xs text-text-muted">Cada tentativa reenvia a mensagem com as opções. Passado o tempo, o fluxo retoma pela saída “Se não tocar”. O total não passa de 24 horas, a janela de resposta.</p>
    </section>
  )
}
