import * as React from "react"
import { Check, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { listIgPosts, setExternalTriggerState, upsertTrigger, type TriggerConfig, type TriggerRepeatMode, type Trigger } from "@/data"
import { isFakeMode } from "@/data/api"
import { listConnections } from "@/data/connections"
import { useAsync } from "@/hooks/use-async"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { KeywordChips } from "@/components/ui/keyword-chips"
import { Label } from "@/components/ui/label"
import { NumberedStep } from "@/components/ui/numbered-step"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SidePanel } from "@/components/ui/side-panel"
import { PanelFooterBar } from "@/components/ui/panel-footer-bar"
import { typeAndChannel } from "../../../../shared/trigger-types"
import { triggersOf } from "./graph"
import { ChannelBadge } from "./channel-badge"
import { triggerPanelTitle } from "./trigger-catalog"
import { CommentLikeOption } from "./comment-like-option"
import { KeywordTriggerPanel, triggerPolicies } from "./keyword-trigger-panel"
import { NodeLinks, type PanelProps } from "./panel-shared"
import { PostTarget } from "./post-target"
import { buildPostChoices, postChoicePatch } from "./post-choice"
import { WordTags } from "./word-tags"
import { RefLinkPanel } from "./ref-link-panel"
import { StoryMentionPanel, StoryReplyPanel } from "./story-trigger-panel"

const MAX_REPLIES = 8
const liveRules = { any: "Qualquer comentário", contains: "Contém", word: "Tem a palavra inteira", begins: "Começa com", is: "É exatamente" } as const
type Draft = { config: TriggerConfig; active: boolean; connectionId: string; repeat: TriggerRepeatMode }

export function TriggerPanel(p: PanelProps) {
  const triggers = triggersOf(p.node, p.triggers)
  const [selected, setSelected] = React.useState(p.triggerId && triggers.some(row => row.id === p.triggerId) ? p.triggerId : triggers[0]?.id ?? "")
  React.useEffect(() => { if (p.triggerId && triggers.some(row => row.id === p.triggerId)) setSelected(p.triggerId) }, [p.triggerId]) // eslint-disable-line react-hooks/exhaustive-deps
  const trigger = triggers.find(row => row.id === selected) ?? triggers[0]
  const label = trigger && trigger.type !== "dm_keyword" ? typeAndChannel(trigger.type, trigger.channel_type) : null
  const picker = label ? <p className="text-xs font-semibold text-text-muted" data-testid="trigger-type-channel">{label}</p> : null
  if (p.creating || !trigger || trigger.type === "dm_keyword") return <KeywordTriggerPanel key={p.creating ? "novo" : trigger?.id} p={p} picker={picker} selectedId={trigger?.id} onSelectTrigger={setSelected} />
  if (trigger.type === "ig_story_reply") return <StoryReplyPanel key={trigger.id} {...p} trigger={trigger} picker={picker} />
  if (trigger.type === "ig_story_mention") return <StoryMentionPanel key={trigger.id} {...p} trigger={trigger} picker={picker} />
  if (trigger.type === "ref_url") return <RefLinkPanel key={trigger.id} {...p} trigger={trigger} picker={picker} />
  if (trigger.type === "hotmart" || trigger.type === "api" || trigger.type === "ad" || trigger.type === "cart_reply" || trigger.type === "ig_share_to_dm") return <ExternalTriggerPanel key={trigger.id} {...p} trigger={trigger} picker={picker} />
  if (trigger.type !== "ig_comment" && trigger.type !== "ig_live_comment") return <SidePanel title={triggerPanelTitle[trigger.type] ?? trigger.name} icon={<ChannelBadge channel={trigger.channel_type} />} tone="trigger" onClose={p.onClose}>{picker}<p className="text-text-muted">Este gatilho ainda não tem opções disponíveis neste painel.</p><NodeLinks p={p} /></SidePanel>
  return <CommentTriggerPanel key={trigger.id} {...p} trigger={trigger} picker={picker} />
}

function CommentTriggerPanel(p: PanelProps & { trigger: Trigger; picker: React.ReactNode }) {
  const { trigger, picker } = p
  const saved: Draft = { config: trigger.config, active: trigger.active, connectionId: trigger.channel_id ?? "", repeat: trigger.repeat_mode ?? "every_time" }
  const [draft, setDraft] = React.useState<Draft>(saved)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")
  const connections = useAsync(() => listConnections(), "comment-connections")
  const eligible = connections.data?.filter(c => c.status === "connected" && c.profile?.inbound?.comment && c.profile.comments?.privateReply) ?? []
  const connection = eligible.find(c => c.id === draft.connectionId)
  const capabilities = connection?.profile?.comments ?? (isFakeMode() ? { posts: true, publicReply: true, like: true, privateReply: { textMaxLength: 1000, urlButtonsMax: 1 } } : undefined)
  const canComment = !!capabilities
  const c = draft.config
  const posts = useAsync(() => capabilities?.posts && draft.connectionId ? listIgPosts(draft.connectionId) : Promise.resolve([]), `comment-posts:${draft.connectionId}:${!!capabilities?.posts}`)
  const availablePosts = posts.data ?? []
  const postOptions = c.post_snapshot && c.post_snapshot.id === c.post_id && !availablePosts.some(post => post.id === c.post_id) ? [c.post_snapshot, ...availablePosts] : availablePosts
  const postChoices = buildPostChoices(postOptions, !!capabilities?.posts)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const unsaved = React.useRef(false)
  React.useEffect(() => { unsaved.current = dirty }, [dirty])
  React.useEffect(() => () => { if (unsaved.current) toast.warning("As alterações do gatilho não foram salvas") }, [])
  const off = p.readOnly || saving
  const setConfig = (patch: Partial<TriggerConfig>) => setDraft({ ...draft, config: { ...c, ...patch } })

  async function onSave() {
    setSaving(true); setError("")
    try {
      const clean = { ...draft.config, public_replies: capabilities?.publicReply ? draft.config.public_replies.map(r => r.trim()).filter(Boolean) : [], like_comment: capabilities?.like ? draft.config.like_comment : false }
      const t = await upsertTrigger(trigger.automation_id, { id: trigger.id, channel_id: draft.connectionId, config: clean, active: draft.active, repeat_mode: draft.repeat })
      p.onTriggerChange(t)
      setDraft({ config: t.config, active: t.active, connectionId: t.channel_id ?? "", repeat: t.repeat_mode ?? "every_time" })
      unsaved.current = false
      toast.success("Gatilho salvo")
    } catch (e) { setError(e instanceof Error ? e.message : "Não consegui salvar o gatilho.") }
    finally { setSaving(false) }
  }

  return <SidePanel title={triggerPanelTitle[trigger.type] ?? trigger.name} icon={<ChannelBadge channel={trigger.channel_type} />} tone="trigger" onClose={p.onClose} footer={
    <PanelFooterBar switchLabel="Gatilho ativo" checked={draft.active} disabled={off || !canComment || !p.published} switchHint={!p.published && !p.readOnly ? "Publique para ativar" : undefined} onCheckedChange={active => setDraft({ ...draft, active })}>
      <Button variant={dirty ? "primary" : "secondary"} onClick={onSave} loading={saving} disabled={off || !dirty || !canComment || c.target === "specific" && !c.post_id}>{dirty ? "Salvar" : <><Check className="size-4" aria-hidden="true" />Salvo</>}</Button>
    </PanelFooterBar>
  }>
    {picker}
    <div className="space-y-1">
      <Label htmlFor="comment-connection">Conexão</Label>
      {connections.loading ? <p role="status" className="text-sm text-text-muted">Carregando conexões…</p> : connections.error ? <Banner variant="danger">Não consegui carregar as conexões.<Button variant="secondary" size="sm" onClick={connections.reload}>Tentar de novo</Button></Banner> : <>
        <Select value={draft.connectionId} disabled={off} onValueChange={connectionId => {
          const profile = eligible.find(row => row.id === connectionId)?.profile?.comments
          setDraft({ ...draft, connectionId, config: { ...c, post_id: undefined, post_snapshot: undefined, public_replies: profile?.publicReply ? c.public_replies : [], like_comment: profile?.like ? c.like_comment : false } })
        }}>
          <SelectTrigger id="comment-connection"><SelectValue placeholder="Escolha uma conexão" /></SelectTrigger>
          <SelectContent>{eligible.map(row => <SelectItem key={row.id} value={row.id}>{row.displayName ?? row.label}</SelectItem>)}</SelectContent>
        </Select>
        {!canComment ? <Banner variant="warning">Escolha uma conexão que aceite comentários recebidos.</Banner> : null}
      </>}
    </div>
    {trigger.type === "ig_live_comment" ? <NumberedStep n={1} title="Quando alguém comenta na sua Live">
      <p className="text-xs text-text-muted">Vale só enquanto a Live está no ar. Cada comentário dispara uma vez.</p>
      <Label htmlFor="live-rule">Condição</Label>
      <Select value={c.rule ?? "any"} disabled={off || !canComment} onValueChange={rule => setConfig({ rule: rule as keyof typeof liveRules, ...(rule === "any" ? { words: [] } : {}) })}>
        <SelectTrigger id="live-rule"><SelectValue /></SelectTrigger>
        <SelectContent>{(Object.keys(liveRules) as (keyof typeof liveRules)[]).map(k => <SelectItem key={k} value={k}>{liveRules[k]}</SelectItem>)}</SelectContent>
      </Select>
      {(c.rule ?? "any") !== "any" ? (off ? <WordTags label="Palavras do comentário" words={c.words ?? []} /> : <KeywordChips label="Palavras do comentário" value={c.words ?? []} onChange={words => setConfig({ words })} />) : null}
    </NumberedStep> : <>
    <NumberedStep n={1} title="Quando alguém comenta">
      <PostTarget noun="publicação" config={c} choices={postChoices} allLabel="Todas as publicações ou Reels"
        nextHint="A primeira publicação depois da ativação será o alvo. Só um gatilho ativo pode aguardar a próxima publicação por conexão."
        loading={posts.loading} error={posts.error} onReload={posts.reload} disabled={off || !canComment}
        onChoose={choice => setConfig(postChoicePatch(choice))} empty="Nenhuma publicação disponível nesta conexão." />
    </NumberedStep>
    <NumberedStep n={2} title="E o comentário">
      <p className="text-text-muted">tem uma destas palavras</p>
      {off ? <WordTags label="Palavras que o comentário deve ter" words={c.include} empty="Qualquer comentário" /> : <KeywordChips label="Palavras que o comentário deve ter" value={c.include} onChange={include => setConfig({ include })} />}
      {off && !c.exclude.length ? null : <>
        <p className="text-text-muted">e não tem</p>
        {off ? <WordTags label="Palavras que o comentário não pode ter" words={c.exclude} /> : <KeywordChips variant="exclude" label="Palavras que o comentário não pode ter" value={c.exclude} onChange={exclude => setConfig({ exclude })} />}
      </>}
    </NumberedStep></>}
    {capabilities?.publicReply ? <NumberedStep n={3} title="Responder também no comentário">
      <p className="text-xs text-text-muted">As respostas se alternam a cada comentário. Sem respostas, nada é publicado.</p>
      <ul className="space-y-2">{c.public_replies.map((reply, i) => <li key={i} className="flex items-center gap-2">
        <Input aria-label={`Resposta ${i + 1}`} value={reply} maxLength={140} disabled={off} onChange={e => setConfig({ public_replies: c.public_replies.map((value, j) => j === i ? e.target.value : value) })} />
        <Button variant="ghost" size="icon" aria-label={`Remover resposta ${i + 1}`} disabled={off} onClick={() => setConfig({ public_replies: c.public_replies.filter((_, j) => j !== i) })}><Trash2 className="size-4" aria-hidden="true" /></Button>
      </li>)}</ul>
      <Button variant="secondary" size="sm" disabled={off || c.public_replies.length >= MAX_REPLIES} onClick={() => setConfig({ public_replies: [...c.public_replies, ""] })}><Plus className="size-4" aria-hidden="true" />Adicionar resposta</Button>
    </NumberedStep> : null}
    <div className="space-y-1">
      <Label htmlFor="comment-repeat">Política de disparo</Label>
      <Select value={draft.repeat} disabled={off || !canComment} onValueChange={v => setDraft({ ...draft, repeat: v as TriggerRepeatMode })}>
        <SelectTrigger id="comment-repeat"><SelectValue /></SelectTrigger>
        <SelectContent>{Object.entries(triggerPolicies).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
      </Select>
      <p className="text-xs text-text-muted">Define quantas vezes o mesmo comentarista recebe a resposta deste gatilho.</p>
    </div>
    <CommentLikeOption comments={capabilities} checked={c.like_comment ?? false} disabled={off} onChange={like_comment => setConfig({ like_comment })} />
    {capabilities?.privateReply ? <p className="text-xs text-text-muted">Ligue uma mensagem ao gatilho para responder no privado. A primeira resposta aceita um texto e um botão de link.</p> : null}
    {error ? <Banner variant="danger"><span role="alert">{error}</span></Banner> : null}
    <NodeLinks p={p} />
  </SidePanel>
}

/** Gatilhos sem palavras (Hotmart, entrada externa, anúncio, direct, carrinho): mostra o que foi criado e liga/desliga depois de publicar. */
function ExternalTriggerPanel(p: PanelProps & { trigger: Trigger; picker: React.ReactNode }) {
  const { trigger, picker } = p
  const [active, setActive] = React.useState(trigger.active)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")
  const ext = trigger.external ?? {}
  const events = Array.isArray(ext.events) ? (ext.events as string[]) : []
  const ids = Array.isArray(ext.product_ids) ? (ext.product_ids as string[]) : Array.isArray(ext.ad_ids) ? (ext.ad_ids as string[]) : []
  const off = p.readOnly || saving
  async function toggle(on: boolean) {
    setSaving(true); setError("")
    try {
      const t = await setExternalTriggerState(trigger.automation_id, trigger, on ? "active" : "draft")
      p.onTriggerChange(t); setActive(t.active)
      toast.success(on ? "Gatilho ativado" : "Gatilho desligado")
    } catch (e) { setError(e instanceof Error ? e.message : "Não consegui salvar o gatilho.") }
    finally { setSaving(false) }
  }
  return <SidePanel title={triggerPanelTitle[trigger.type] ?? trigger.name} icon={<ChannelBadge channel={trigger.channel_type} />} tone="trigger" onClose={p.onClose} footer={
    <PanelFooterBar switchLabel="Gatilho ativo" checked={active} disabled={off || !p.published} switchHint={!p.published && !p.readOnly ? "Publique para ativar" : undefined} onCheckedChange={toggle}>
      <Button variant="secondary" onClick={p.onClose}>Fechar</Button>
    </PanelFooterBar>
  }>
    {picker}
    <h3 className="break-words text-sm font-semibold">{trigger.name}</h3>
    {trigger.type === "api" ? <p className="text-sm text-text-muted">Dispare com <code>POST /api/public/v1/triggers/fire</code> e <code>trigger_name</code> “{typeof ext.trigger_name === "string" ? ext.trigger_name : trigger.name}”. Não usa conexão de canal.</p> : null}
    {trigger.type === "hotmart" ? <>
      <p className="text-sm text-text-muted">Compra aprovada, completa ou carrinho abandonado{events.length ? ` (${events.length} eventos)` : ""}. Registre a URL do webhook em Configurações &gt; Integrações.</p>
      <p className="text-sm text-text-muted">{ids.length ? `Produtos: ${ids.join(", ")}` : "Vale para qualquer produto."}</p>
    </> : null}
    {trigger.type === "ad" ? <p className="text-sm text-text-muted">{ids.length ? `Anúncios: ${ids.join(", ")}` : "Vale para qualquer anúncio."}</p> : null}
    {trigger.type === "cart_reply" ? <p className="text-sm text-text-muted">O pedido do carrinho fica na variável {"{{ultimo_carrinho}}"}.</p> : null}
    {trigger.type === "ig_share_to_dm" ? <p className="text-sm text-text-muted">Dispara uma vez por contato quando ele compartilha um post ou reel no direct.</p> : null}
    {!active ? <Banner variant="warning">{p.published ? "Este gatilho está desligado e ainda não dispara a automação." : "Publique a automação para poder ativar este gatilho."}</Banner> : null}
    {error ? <Banner variant="danger"><span role="alert">{error}</span></Banner> : null}
    <NodeLinks p={p} />
  </SidePanel>
}
