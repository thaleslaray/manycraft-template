import * as React from "react"
import { ChannelBadge } from "./channel-badge"
import { triggerPanelTitle } from "./trigger-catalog"
import { Check, Heart } from "lucide-react"
import { toast } from "sonner"
import { listIgStories, saveStoryTrigger, type StoryDelay, type Trigger, type TriggerConfig, type TriggerRepeatMode, type TriggerState } from "@/data"
import { listConnections } from "@/data/connections"
import { useAsync } from "@/hooks/use-async"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { KeywordChips } from "@/components/ui/keyword-chips"
import { Label } from "@/components/ui/label"
import { NumberedStep } from "@/components/ui/numbered-step"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PanelFooterBar } from "@/components/ui/panel-footer-bar"
import { SidePanel } from "@/components/ui/side-panel"
import { Switch } from "@/components/ui/switch"
import { NodeLinks, type PanelProps } from "./panel-shared"
import { WordTags } from "./word-tags"
import { PostTarget } from "./post-target"
import { ALL_ID, postChoicePatch } from "./post-choice"

const replyRules = { any: "Qualquer resposta", contains: "Contém uma destas palavras", is: "É igual a uma destas palavras" } as const
const replyRepeat: Record<TriggerRepeatMode, string> = { every_time: "Sempre que responderem", once_per_24_hours: "Uma vez a cada 24 horas", once: "Uma vez por contato" }
const mentionRepeat = { every_time: "Toda menção", once_per_24_hours: "Uma vez a cada 24 horas" } as const
const delays: Record<StoryDelay, string> = { 0: "Sem atraso", 30: "30 segundos", 60: "1 minuto", 300: "5 minutos", 600: "10 minutos" }
type Draft = { config: TriggerConfig; state: TriggerState; repeat: TriggerRepeatMode; connectionId: string }

/** Rascunho, salvamento e rodapé comuns aos dois gatilhos de story. */
function useStoryDraft(p: PanelProps, trigger: Trigger) {
  const state = trigger.state ?? (trigger.active ? "active" : "draft")
  const saved: Draft = { config: trigger.config, state, repeat: trigger.repeat_mode ?? "every_time", connectionId: trigger.channel_id ?? "" }
  const [draft, setDraft] = React.useState<Draft>(saved)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const unsaved = React.useRef(false)
  React.useEffect(() => { unsaved.current = dirty }, [dirty])
  React.useEffect(() => () => { if (unsaved.current) toast.warning("As alterações do gatilho não foram salvas") }, [])
  const setConfig = (patch: Partial<TriggerConfig>) => setDraft(d => ({ ...d, config: { ...d.config, ...patch } }))
  async function save() {
    setSaving(true); setError("")
    try {
      const t = await saveStoryTrigger(trigger.automation_id, trigger, { connection_id: draft.connectionId, config: draft.config, state: draft.state, repeat_mode: draft.repeat })
      p.onTriggerChange(t)
      setDraft({ config: t.config, state: t.state ?? (t.active ? "active" : "draft"), repeat: t.repeat_mode ?? "every_time", connectionId: t.channel_id ?? "" })
      unsaved.current = false
      toast.success("Gatilho salvo")
    } catch (e) { setError(e instanceof Error ? e.message : "Não consegui salvar o gatilho.") }
    finally { setSaving(false) }
  }
  const cancel = () => { unsaved.current = false; setDraft(saved); p.onClose() }
  return { draft, setDraft, setConfig, saving, error, dirty, save, cancel, off: p.readOnly || saving, published: !!p.published, readOnly: p.readOnly }
}

function Footer({ draft, setDraft, off, canSave, saving, dirty, save, published, readOnly }: ReturnType<typeof useStoryDraft> & { canSave: boolean }) {
  return <PanelFooterBar switchLabel="Gatilho ativo" checked={draft.state === "active"} disabled={off || !canSave || !published} switchHint={!published && !readOnly ? "Publique para ativar" : undefined} onCheckedChange={on => setDraft({ ...draft, state: on ? "active" : "draft" })}>
    <Button variant={dirty ? "primary" : "secondary"} onClick={save} loading={saving} disabled={off || !dirty || !canSave}>{dirty ? "Salvar" : <><Check className="size-4" aria-hidden="true" />Salvo</>}</Button>
  </PanelFooterBar>
}

/** Conexões que a ficha efetiva declara capazes: nenhum nome de canal é consultado. */
function useConnectionPicker({ s, kind }: { s: ReturnType<typeof useStoryDraft>; kind: "reply" | "mention" }) {
  const connections = useAsync(() => listConnections(), "story-connections")
  const eligible = connections.data?.filter(c => c.status === "connected" && (kind === "reply" ? c.profile?.stories?.reply && c.profile.inbound?.storyReply : c.profile?.stories?.mention)) ?? []
  const current = eligible.find(c => c.id === s.draft.connectionId)
  return { eligible, current, loading: connections.loading, node: <div className="space-y-1">
    <Label htmlFor="story-connection">Conexão</Label>
    {connections.loading ? <p role="status" className="text-sm text-text-muted">Carregando conexões…</p> : connections.error ? <Banner variant="danger">Não consegui carregar as conexões.<Button variant="secondary" size="sm" onClick={connections.reload}>Tentar de novo</Button></Banner> : <>
      <Select value={s.draft.connectionId} disabled={s.off} onValueChange={connectionId => {
        const stories = eligible.find(row => row.id === connectionId)?.profile?.stories
        s.setDraft(d => ({ ...d, connectionId, config: { ...d.config, post_id: undefined, post_snapshot: undefined, heart: stories?.heart ? d.config.heart : false } }))
      }}>
        <SelectTrigger id="story-connection"><SelectValue placeholder="Escolha uma conexão" /></SelectTrigger>
        <SelectContent>{eligible.map(row => <SelectItem key={row.id} value={row.id}>{row.displayName ?? row.label}</SelectItem>)}</SelectContent>
      </Select>
      {!current ? <Banner variant="warning">{kind === "reply" ? "Escolha uma conexão que receba respostas a story." : "Escolha uma conexão que receba menções em story."}</Banner> : null}
    </>}
  </div> }
}

export function StoryReplyPanel(p: PanelProps & { trigger: Trigger; picker: React.ReactNode }) {
  const { trigger, picker } = p
  const s = useStoryDraft(p, trigger)
  const picked = useConnectionPicker({ s, kind: "reply" })
  const c = s.draft.config, rule = c.rule ?? "any", words = c.words ?? []
  const canList = !!picked.current?.profile?.stories?.list
  const stories = useAsync(() => canList && s.draft.connectionId ? listIgStories(s.draft.connectionId) : Promise.resolve([]), `story-list:${s.draft.connectionId}:${canList}`)
  const available = stories.data ?? []
  const options = c.post_snapshot && c.post_snapshot.id === c.post_id && !available.some(story => story.id === c.post_id) ? [c.post_snapshot, ...available] : available
  const storyChoices = [{ id: ALL_ID, label: "Qualquer story", kind: "all" as const }, ...(canList ? options.map(story => ({ id: story.id, label: story.caption || `Story ${story.id}`, kind: "post" as const, post: story })) : [])]
  const invalid = c.target === "specific" && !c.post_id || rule !== "any" && !words.length
  const heart = !!picked.current?.profile?.stories?.heart
  return <SidePanel title={triggerPanelTitle[trigger.type] ?? trigger.name} icon={<ChannelBadge channel={trigger.channel_type} />} tone="trigger" onClose={p.onClose} footer={<Footer {...s} canSave={!!picked.current && !invalid} />}>
    {picker}
    {picked.node}
    <NumberedStep n={1} title="Quando alguém responde a um story">
      <PostTarget noun="story" config={c} choices={storyChoices} allLabel="Qualquer story"
        loading={stories.loading} error={stories.error} onReload={stories.reload} disabled={s.off || !picked.current}
        onChoose={choice => s.setConfig(postChoicePatch(choice))} empty="Nenhum story no ar agora. Um story sai do ar depois de 24 horas." />
    </NumberedStep>
    <NumberedStep n={2} title="E a resposta">
      <Label htmlFor="story-rule">Condição</Label>
      <Select value={rule} disabled={s.off} onValueChange={next => s.setConfig({ rule: next as "any" | "contains" | "is", ...(next === "any" ? { words: [] } : {}) })}>
        <SelectTrigger id="story-rule"><SelectValue /></SelectTrigger>
        <SelectContent>{(Object.keys(replyRules) as (keyof typeof replyRules)[]).map(k => <SelectItem key={k} value={k}>{replyRules[k]}</SelectItem>)}</SelectContent>
      </Select>
      {rule !== "any" ? (s.off ? <WordTags label="Palavras da resposta" words={words} /> : <KeywordChips label="Palavras da resposta" value={words} onChange={next => s.setConfig({ words: next })} />) : null}
    </NumberedStep>
    <div className="space-y-1">
      <Label htmlFor="story-reply-delay">Esperar antes de responder</Label>
      <Select value={String(c.delay_seconds ?? 0)} disabled={s.off} onValueChange={v => s.setConfig({ delay_seconds: Number(v) as StoryDelay })}>
        <SelectTrigger id="story-reply-delay"><SelectValue /></SelectTrigger>
        <SelectContent>{(Object.keys(delays) as unknown as StoryDelay[]).map(k => <SelectItem key={k} value={String(k)}>{delays[k]}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    {heart ? <div className="flex items-center gap-3 rounded-md border border-border p-3">
      <Heart className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
      <Label htmlFor="story-reply-heart" className="flex-1">Reagir com coração à resposta</Label>
      <Switch id="story-reply-heart" checked={c.heart ?? false} disabled={s.off} onCheckedChange={on => s.setConfig({ heart: on })} />
    </div> : null}
    <div className="space-y-1">
      <Label htmlFor="story-repeat">Frequência</Label>
      <Select value={s.draft.repeat} disabled={s.off} onValueChange={repeat => s.setDraft(d => ({ ...d, repeat: repeat as TriggerRepeatMode }))}>
        <SelectTrigger id="story-repeat"><SelectValue /></SelectTrigger>
        <SelectContent>{(Object.keys(replyRepeat) as TriggerRepeatMode[]).map(k => <SelectItem key={k} value={k}>{replyRepeat[k]}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <p className="text-xs text-text-muted">Quando mais de uma regra combina, vale a do story específico. A resposta ao story abre a conversa, então a mensagem ligada a este gatilho chega no privado.</p>
    {s.error ? <Banner variant="danger"><span role="alert">{s.error}</span></Banner> : null}
    <NodeLinks p={p} />
  </SidePanel>
}

export function StoryMentionPanel(p: PanelProps & { trigger: Trigger; picker: React.ReactNode }) {
  const { trigger, picker } = p
  const s = useStoryDraft(p, trigger)
  const picked = useConnectionPicker({ s, kind: "mention" })
  const c = s.draft.config
  const repeat = s.draft.repeat === "once_per_24_hours" ? "once_per_24_hours" : "every_time"
  const heart = !!picked.current?.profile?.stories?.heart
  return <SidePanel title={triggerPanelTitle[trigger.type] ?? trigger.name} icon={<ChannelBadge channel={trigger.channel_type} />} tone="trigger" onClose={p.onClose} footer={<Footer {...s} canSave={!!picked.current} />}>
    {picker}
    {picked.node}
    <NumberedStep n={1} title="Quando alguém menciona você em um story">
      <p className="text-sm text-text-muted">A mensagem ligada a este gatilho vai para quem mencionou, no privado.</p>
      <Label htmlFor="story-delay">Esperar antes de responder</Label>
      <Select value={String(c.delay_seconds ?? 0)} disabled={s.off} onValueChange={v => s.setConfig({ delay_seconds: Number(v) as StoryDelay })}>
        <SelectTrigger id="story-delay"><SelectValue /></SelectTrigger>
        <SelectContent>{(Object.keys(delays) as unknown as StoryDelay[]).map(k => <SelectItem key={k} value={String(k)}>{delays[k]}</SelectItem>)}</SelectContent>
      </Select>
    </NumberedStep>
    <div className="space-y-1">
      <Label htmlFor="story-mention-repeat">Frequência</Label>
      <Select value={repeat} disabled={s.off} onValueChange={v => s.setDraft(d => ({ ...d, repeat: v as TriggerRepeatMode }))}>
        <SelectTrigger id="story-mention-repeat"><SelectValue /></SelectTrigger>
        <SelectContent>{(Object.keys(mentionRepeat) as (keyof typeof mentionRepeat)[]).map(k => <SelectItem key={k} value={k}>{mentionRepeat[k]}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    {heart ? <div className="flex items-center gap-3 rounded-md border border-border p-3">
      <Heart className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
      <Label htmlFor="story-heart" className="flex-1">Reagir com coração à menção</Label>
      <Switch id="story-heart" checked={c.heart ?? false} disabled={s.off} onCheckedChange={on => s.setConfig({ heart: on })} />
    </div> : picked.current ? <p className="text-xs text-text-muted">Esta conexão não envia reação de coração.</p> : null}
    {s.error ? <Banner variant="danger"><span role="alert">{s.error}</span></Banner> : null}
    <NodeLinks p={p} />
  </SidePanel>
}
