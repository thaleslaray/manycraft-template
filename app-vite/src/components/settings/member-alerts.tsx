import * as React from "react"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import { useAsync } from "@/hooks/use-async"
import { useCan } from "@/hooks/use-role"
import { useParams } from "react-router"
import { settingsKeys } from "@/data/screen-keys"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { SettingsRow, SettingsRows } from "./settings-rows"

export type MemberAlertsData = {
  account_email: string; email_enabled: boolean; alert_email: string | null
  chat_linked: boolean; chat_bot: string | null; chat_bots: { id: string; name: string }[]
  on_assigned_message: boolean; on_unassigned: boolean; on_assigned_to_me: boolean; interval_minutes: number
}
type Link = { code: string; url: string | null; bot: string | null }

const events = [
  ["on_assigned_message", "Nova mensagem em uma conversa atribuída a mim"],
  ["on_unassigned", "Nova conversa sem responsável"],
  ["on_assigned_to_me", "Uma conversa foi atribuída a mim"],
] as const

const fake: MemberAlertsData = { account_email: "voce@exemplo.com", email_enabled: true, alert_email: null, chat_linked: false, chat_bot: null, chat_bots: [],
  on_assigned_message: false, on_unassigned: false, on_assigned_to_me: false, interval_minutes: 5 }

const spaceLabels = { connection: "Conexão que parou de funcionar", restriction: "Restrição da conta" } as const
type SpacePrefs = Record<keyof typeof spaceLabels, boolean>

function Check({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (on: boolean) => void; children: React.ReactNode }) {
  return <label htmlFor={id} className="flex items-start gap-2 text-sm"><Checkbox id={id} className="mt-0.5" checked={checked} onCheckedChange={on => onChange(on === true)} /><span>{children}</span></label>
}

export const loadMemberAlerts = () => isFakeMode() ? Promise.resolve(fake) : apiRequest<MemberAlertsData>("/me/alerts")
export const loadNoticePrefs = () => isFakeMode() ? Promise.resolve({ preferences: { connection: true, restriction: true } as SpacePrefs }) : apiRequest<{ preferences: SpacePrefs }>("/notices")

/** Configurações > Notificações: o que cada pessoa quer receber fora do painel (qualquer papel) e quais avisos do espaço também vão por e-mail ao dono. */
export function NotificationsSettings() {
  const { workspace = "" } = useParams()
  // Do cache, a tela abre com o último dado salvo; o que a pessoa edita fica no rascunho (draft) e a revalidação não o sobrescreve.
  const data = useAsync(loadMemberAlerts, "member-alerts", { cache: settingsKeys.memberAlerts(workspace) })
  const space = useAsync(loadNoticePrefs, "notice-prefs", { cache: settingsKeys.noticePrefs(workspace) })
  const canEdit = useCan("edit")
  const saved = data.data
  const [draft, setDraft] = React.useState<MemberAlertsData | null>(null)
  const [bot, setBot] = React.useState("")
  const [link, setLink] = React.useState<Link | null>(null)
  const current = draft ?? saved
  const fail = (e: Error) => toast.error(e.message)
  // Um pedido por vez: enquanto um aviso é gravado, os controles ficam travados e um clique rápido não grava por cima do anterior.
  const [pending, setPending] = React.useState(false)
  const one = <T,>(request: Promise<T>) => { setPending(true); return request.finally(() => setPending(false)) }
  // Salva o que a tela mostra; as caixas de avisos gravam na hora, o e-mail só pelo botão ao lado do endereço.
  const put = (next: MemberAlertsData, keep?: Partial<MemberAlertsData>) => one(apiRequest("/me/alerts", { method: "PUT", body: JSON.stringify({ email_enabled: next.email_enabled, alert_email: next.alert_email?.trim() || null,
    on_assigned_message: next.on_assigned_message, on_unassigned: next.on_unassigned, on_assigned_to_me: next.on_assigned_to_me }) }))
    .then(() => { toast.success("Avisos salvos."); setDraft(keep && draft ? { ...draft, ...keep } : null); data.reload() }).catch(fail)
  const save = () => current && put(current)
  const toggleEvent = (key: (typeof events)[number][0], on: boolean) => saved && put({ ...saved, [key]: on }, { [key]: on })
  const generate = (channel_id: string) => one(apiRequest<Link>("/me/alerts/chat-link", { method: "POST", body: JSON.stringify({ channel_id }) })).then(setLink).catch(fail)
  const unlink = () => one(apiRequest("/me/alerts/chat", { method: "DELETE" })).then(() => { setLink(null); toast.success("Telegram desvinculado."); data.reload() }).catch(fail)
  const set = (patch: Partial<MemberAlertsData>) => current && setDraft({ ...current, ...patch })
  const spacePrefs = space.data?.preferences
  const saveSpace = (next: SpacePrefs) => one(apiRequest("/notices/preferences", { method: "PUT", body: JSON.stringify(next) })).then(() => { toast.success("Preferências salvas."); space.reload() }).catch(fail)
  if (!current) return <p role="status" className="text-sm text-text-muted">Carregando…</p>
  return <div className="space-y-4">
    <SettingsRows label="Caixa de entrada">
      <SettingsRow label="Notificações da caixa de entrada" help={`Receba por e-mail e Telegram o que acontece na caixa de entrada. Para não lotar sua caixa, mandamos no máximo um aviso por conversa a cada ${current.interval_minutes} minutos. Aviso por push não existe aqui.`}>
        <fieldset disabled={pending} className="space-y-3">
          <legend className="mb-3 text-sm font-semibold">Notificar-me quando</legend>
          {events.map(([key, label]) => <Check key={key} id={`alert-${key}`} checked={current[key]} onChange={on => void toggleEvent(key, on)}>{label}</Check>)}
        </fieldset>
      </SettingsRow>
    </SettingsRows>
    <SettingsRows label="Avisos do espaço">
      <SettingsRow label="Avisos do espaço" help="Todos os avisos aparecem no sininho do topo. Marque os que também devem ir por e-mail ao dono do espaço.">
        {spacePrefs ? <fieldset disabled={!canEdit || pending} className="space-y-3">
          <legend className="sr-only">Avisos do espaço por e-mail</legend>
          {(Object.keys(spaceLabels) as (keyof SpacePrefs)[]).map(k => <Check key={k} id={`space-${k}`} checked={spacePrefs[k] !== false} onChange={on => void saveSpace({ ...spacePrefs, [k]: on })}>{spaceLabels[k]}</Check>)}
        </fieldset> : <p className="text-sm text-text-muted">Carregando…</p>}
      </SettingsRow>
    </SettingsRows>
    <SettingsRows label="Onde receber">
      <SettingsRow label="Meu Telegram para notificações" help={current.chat_linked || current.chat_bots.length ? "Abra o link gerado no Telegram e toque em Iniciar." : "Conecte um bot do Telegram em Canais para receber avisos por lá."}>
        {current.chat_linked ? <p className="flex flex-wrap items-center gap-3 text-sm">Chat vinculado. <Button size="sm" variant="secondary" className="border-danger text-danger" disabled={pending} onClick={() => void unlink()}>Desvincular</Button></p>
          : current.chat_bots.length === 0 ? <p className="text-sm text-text-muted">Nenhum bot conectado.</p> : <div className="space-y-3">
            <label htmlFor="alert-bot" className="block text-sm font-medium">Bot que vai mandar os avisos</label>
            <select id="alert-bot" className="h-10 w-full rounded-md border border-border-input bg-surface px-3 text-sm" value={bot || current.chat_bots[0]!.id} onChange={e => setBot(e.target.value)}>
              {current.chat_bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => void generate(bot || current.chat_bots[0]!.id)}>Gerar link de vínculo</Button>
            {link ? <p className="text-sm">Abra o link no Telegram e toque em Iniciar (vale por 15 minutos): {link.url ? <a className="text-text underline" href={link.url} target="_blank" rel="noreferrer">{link.url}</a> : <>envie <code>/start {link.code}</code> ao bot</>}. Depois volte e recarregue esta tela.</p> : null}
          </div>}
      </SettingsRow>
      <SettingsRow label="Meu e-mail para notificações" htmlFor="alert-email" help={`Em branco, usamos o e-mail da sua conta (${current.account_email}).`}>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input id="alert-email" type="email" placeholder={current.account_email} value={current.alert_email ?? ""} onChange={e => set({ alert_email: e.target.value })} />
            <Button onClick={() => void save()} loading={pending} disabled={!draft || pending}>Salvar avisos</Button>
          </div>
          <Check id="alert-email-on" checked={current.email_enabled} onChange={on => set({ email_enabled: on })}>Avisar por e-mail</Check>
        </div>
      </SettingsRow>
    </SettingsRows>
  </div>
}
