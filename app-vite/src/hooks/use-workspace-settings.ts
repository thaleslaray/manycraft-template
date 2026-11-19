import * as React from "react"
import { getWorkspaceSettings, onWorkspaceSettingsChange, peekWorkspaceSettings, type WorkspaceSettings } from "@/data/workspace-settings"

/** Preferências do espaço; null enquanto carrega ou se não carregou (a tela usa o padrão). */
export function useWorkspaceSettings(): WorkspaceSettings | null {
  const [settings, setSettings] = React.useState<WorkspaceSettings | null>(peekWorkspaceSettings)
  React.useEffect(() => {
    let live = true
    const load = () => { getWorkspaceSettings().then(s => { if (live) setSettings(s) }).catch(() => {}) }
    load()
    const stop = onWorkspaceSettingsChange(load)
    return () => { live = false; stop() }
  }, [])
  return settings
}
