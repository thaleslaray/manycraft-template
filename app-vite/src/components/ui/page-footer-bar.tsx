import * as React from "react"
import { cn } from "@/lib/utils"

/** Barra de ações fixa no pé de uma página inteira (formulário longo): cancelar e salvar à direita. No painel lateral ou na janela, use `PanelFooterBar`. */
function PageFooterBar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div role="group" aria-label="Ações da página" className={cn("sticky bottom-0 -mx-1 flex flex-wrap justify-end gap-2 border-t border-border bg-bg px-1 py-4", className)}>{children}</div>
}

export { PageFooterBar }
