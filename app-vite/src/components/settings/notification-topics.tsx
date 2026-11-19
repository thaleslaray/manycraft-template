import * as React from "react"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import { listConnections } from "@/data"
import { useAsync } from "@/hooks/use-async"
import { settingsKeys } from "@/data/screen-keys"
import { useParams } from "react-router"
import { Button } from "@/components/ui/button"
import { Input, field } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Topic = { id: string; name: string; channel_name: string; frequency: "daily" | "weekly" | "monthly"; validity_days: number; subscribers: number; expiring: number; lapsed: number }
const frequencyText = { daily: "Diário", weekly: "Semanal", monthly: "Mensal" } as const

/** Configurações > Tópicos de notificação: listas por conexão; o passo "Inscrever no tópico" põe o contato e renova a validade (re-opt-in). */
export const loadTopics = () => isFakeMode() ? Promise.resolve([] as Topic[]) : apiRequest<{ items: Topic[] }>("/notification-topics").then(r => r.items)
export function NotificationTopics() {
  const { workspace = "" } = useParams()
  const list = useAsync(loadTopics, "notification-topics", { cache: settingsKeys.topics(workspace) })
  const connections = useAsync(() => listConnections(workspace), "topic-connections", { cache: `topic-connections|${workspace}` })
  const [name, setName] = React.useState("")
  const [channel, setChannel] = React.useState("")
  const [frequency, setFrequency] = React.useState<Topic["frequency"]>("weekly")
  const act = (p: Promise<unknown>, ok: string) => p.then(() => { toast.success(ok); list.reload() }).catch((e: Error) => toast.error(e.message))
  return <section aria-label="Tópicos de notificação" className="min-w-0 space-y-4 rounded-lg border border-border bg-surface p-6">
    <h2 className="text-lg font-semibold">Tópicos de notificação</h2>
    <p className="text-sm text-text-muted">Listas que o contato aceita receber (ex.: ofertas da semana). Inscreva pelo passo de ação no fluxo e filtre o público da transmissão pelo tópico. A inscrição vence; quem está para vencer precisa aceitar de novo.</p>
    <form className="grid gap-2 sm:grid-cols-[1fr_12rem_9rem_auto] sm:items-end" onSubmit={e => { e.preventDefault(); void act(apiRequest("/notification-topics", { method: "POST", body: JSON.stringify({ name: name.trim(), channel_id: channel, frequency }) }).then(() => setName("")), "Tópico criado.") }}>
      <div className="space-y-1"><Label htmlFor="topic-name">Nome</Label><Input id="topic-name" value={name} maxLength={100} onChange={e => setName(e.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor="topic-channel">Conexão</Label><select id="topic-channel" className={`${field} h-10 w-full`} value={channel} onChange={e => setChannel(e.target.value)}>
        <option value="">Escolha</option>{(connections.data ?? []).map(c => <option key={c.id} value={c.id}>{c.displayName ?? c.label}</option>)}</select></div>
      <div className="space-y-1"><Label htmlFor="topic-frequency">Frequência</Label><select id="topic-frequency" className={`${field} h-10 w-full`} value={frequency} onChange={e => setFrequency(e.target.value as Topic["frequency"])}>
        {Object.entries(frequencyText).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
      <Button type="submit" disabled={!name.trim() || !channel}>Criar</Button>
    </form>
    {list.data?.length ? <ul className="divide-y divide-border">{list.data.map(t => <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
      <div><p className="font-medium">{t.name}</p><p className="text-xs text-text-muted">{t.channel_name} · {frequencyText[t.frequency]} · validade de {t.validity_days} dias</p></div>
      <div className="flex items-center gap-3"><span><strong>{t.subscribers}</strong> inscritos</span>{t.expiring ? <span className="text-warning">{t.expiring} vencem em 7 dias</span> : null}{t.lapsed ? <span className="text-text-muted">{t.lapsed} saíram ou venceram</span> : null}
        <Button size="sm" variant="secondary" onClick={() => void act(apiRequest("/email/segments", { method: "POST", body: JSON.stringify({ name: `Tópico: ${t.name}`.slice(0, 120), filter: { match: "all", rules: [{ type: "topic", topic_id: t.id, operator: "has" }] } }) }), "Segmento criado: use-o como público da transmissão.")}>Criar segmento</Button>
        <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`Excluir o tópico "${t.name}"? As inscrições saem junto.`)) void act(apiRequest(`/notification-topics/${t.id}`, { method: "DELETE" }), "Tópico excluído.") }}>Excluir</Button></div>
    </li>)}</ul> : <p className="text-sm text-text-muted">{list.loading ? "Carregando…" : "Nenhum tópico ainda."}</p>}
  </section>
}
