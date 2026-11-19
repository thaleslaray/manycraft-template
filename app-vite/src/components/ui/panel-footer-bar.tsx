import * as React from "react"
import { Switch } from "@/components/ui/switch"

/** Barra inferior fixa do painel lateral: interruptor (ou `status`, texto sem controle) à esquerda, ações à direita. Vai no `footer` do SidePanel (o corpo rola acima). */
function PanelFooterBar({
  switchLabel,
  checked,
  onCheckedChange,
  disabled,
  switchHint,
  status,
  children,
}: {
  switchLabel?: string
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  /** Dica sob o interruptor (ex.: por que está desabilitado). */
  switchHint?: string
  /** No lugar do interruptor: um texto de estado, para painéis sem ativar/desativar. */
  status?: React.ReactNode
  children: React.ReactNode
}) {
  const id = React.useId()
  return (
    <div role="group" aria-label="Ações do painel" className="flex items-center justify-between gap-3">
      {switchLabel ? <div className="flex items-center gap-2" title={switchHint}>
        <Switch id={id} checked={checked ?? false} disabled={disabled} aria-describedby={switchHint ? `${id}-dica` : undefined} onCheckedChange={onCheckedChange} />
        <div className="min-w-0">
          <label htmlFor={id} className="text-sm font-semibold">{switchLabel}</label>
          {switchHint ? <p id={`${id}-dica`} className="text-xs text-text-muted">{switchHint}</p> : null}
        </div>
      </div> : <div className="min-w-0">{status}</div>}
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

export { PanelFooterBar }
