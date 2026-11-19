import { AvatarInitials } from "./avatar-initials"
import { useWorkspaceSettings } from "@/hooks/use-workspace-settings"

/** Foto da conta (Configurações › Geral); sem foto, a inicial do nome. Acompanha as mudanças feitas nas configurações. */
export function AccountAvatar({ className }: { className?: string }) {
  const settings = useWorkspaceSettings()
  return <AvatarInitials name={settings?.name ?? "?"} src={settings?.photo_url ?? undefined} className={className} />
}
