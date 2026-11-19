import * as React from "react"
import { apiRequest } from "@/data/api"
const hotmartEvents = ["PURCHASE_APPROVED", "PURCHASE_COMPLETE", "PURCHASE_OUT_OF_SHOPPING_CART"]
import { toast } from "sonner"
import { Link, useParams } from "react-router"
import { listAutomationTriggers, createKeywordTrigger, createCommentTrigger, createRefTrigger, createStoryTrigger, updateKeywordTrigger, type Trigger, type TriggerKeyword, type TriggerKeywordRule, type TriggerState, type TriggerRepeatMode } from "@/data"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { KeywordChips } from "@/components/ui/keyword-chips"
import { withPending } from "@/components/ui/keyword-merge"
import { setPendingTrigger } from "./pending-trigger"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SidePanel } from "@/components/ui/side-panel"
import { Input } from "@/components/ui/input"
import { listConnections } from "@/data/connections"
import { useAsync } from "@/hooks/use-async"
import { triggersOf } from "./graph"
import { MoreOptions, NodeLinks, type PanelProps } from "./panel-shared"
import { ChannelBadge } from "./channel-badge"
import { triggerCards, triggerPanelTitle } from "./trigger-catalog"
import { PanelFooterBar } from "@/components/ui/panel-footer-bar"
import { handleLabel, isRefConnection } from "./ref-link-panel"
import { Textarea } from "@/components/ui/textarea"
import { listKeywords, setKeywordActive } from "@/data/keywords"
import { conditionFromEngineRule, findKeywordConflicts, type ConflictCandidate, type KeywordConflict } from "@/data/keyword-conflicts"
import { KeywordConflictNotice } from "@/components/keywords/keyword-conflict-notice"

/** Regras de Palavras-chave (inclusive gatilhos de outras automações) que também pegam as palavras deste gatilho. */
function useKeywordConflicts(target: ConflictCandidate | null) {
  const { workspace = "" } = useParams()
  const rows = useAsync(() => listKeywords(workspace), `keyword-conflicts|${workspace}`)
  const [busy, setBusy] = React.useState(false)
  const conflicts = target && rows.data ? findKeywordConflicts(target, rows.data) : []
  async function pause(c: KeywordConflict) {
    setBusy(true)
    try { await setKeywordActive(workspace, c.other.id, false); toast.success(`Regra “${c.other.name}” pausada.`); rows.reload() }
    catch (e) { toast.error(e instanceof Error ? e.message : "Não consegui pausar a outra regra.") }
    finally { setBusy(false) }
  }
  return { conflicts, busy, pause }
}

const rules: Record<TriggerKeywordRule, string> = {
  is: "Mensagem igual à palavra",
  contains: "Mensagem contém a palavra",
  starts_with: "Mensagem começa com a palavra",
  word_match: "Mensagem contém a palavra inteira",
  does_not_contain: "Mensagem não contém nenhuma palavra",
  thumbs_up: "Curtir (só o polegar para cima)",
  any: "Qualquer mensagem",
}

export const triggerStates = { active: "Ativo", draft: "Rascunho", initial: "Inicial" } as const
export const triggerPolicies = { every_time: "Sempre", once_per_24_hours: "Uma vez a cada 24 horas", once: "Uma vez por contato" } as const

export function KeywordTriggerPanel({ p, picker, selectedId, onSelectTrigger }: { p: PanelProps; picker?: React.ReactNode; selectedId?: string; onSelectTrigger?: (id: string) => void }) {
  const triggers = triggersOf(p.node, p.triggers).filter(t => t.type === "dm_keyword")
  const trigger = triggers.find(t => t.id === selectedId) ?? triggers[0]
  const icon = <ChannelBadge channel={trigger?.channel_type ?? p.creating?.channel} />
  if (p.creating) return <SidePanel title="Novo gatilho" icon={icon} tone="trigger" onClose={p.onClose}>
    {picker}
    <NewKeywordTrigger p={p} initial={p.creating} onCreated={t => { p.onTriggerChange(t); onSelectTrigger?.(t.id); p.onCreated?.() }} onCancel={() => p.onCreated?.()} />
  </SidePanel>
  if (!trigger) return <SidePanel title="Gatilho" icon={icon} tone="trigger" onClose={p.onClose}>
    {picker}
    <p className="text-sm text-text-muted">Adicione um gatilho com “+ Novo gatilho” no mapa para receber mensagens por uma conexão.</p>
    <NodeLinks p={p} />
  </SidePanel>
  return <KeywordDetails key={trigger.id} p={p} trigger={trigger} picker={picker} icon={icon} />
}

function NewKeywordTrigger({ p, initial, onCreated, onCancel }: { p: PanelProps; initial: { kind: string; channel: string; connectionKind?: string }; onCreated: (t: Trigger) => void; onCancel: () => void }) {
  const connections = useAsync(() => listConnections(), "trigger-connections")
  const kind = initial.kind
  const eligible = connections.data?.filter(c => c.status === "connected" && (!initial.connectionKind || c.kind === initial.connectionKind) && (kind === "ref_url" ? isRefConnection(c) : kind === "comment" || kind === "live_comment" ? c.profile?.inbound?.comment && c.profile.comments?.privateReply : kind === "ad" ? c.kind === "whatsapp" || c.kind === "instagram" : kind === "story_reply" ? c.profile?.stories?.reply && c.profile.inbound?.storyReply : kind === "story_mention" ? c.profile?.stories?.mention : c.profile?.inbound?.message)) ?? []
  const [name, setName] = React.useState("")
  const [connection, setConnection] = React.useState("")
  const [chips, setWords] = React.useState<string[]>([])
  const [pendingWord, setPendingWord] = React.useState("")
  /** Chips mais o texto ainda sem Enter: conta para habilitar e entra ao criar. */
  const words = withPending(chips, pendingWord)
  const [handle, setHandle] = React.useState("")
  const [prefill, setPrefill] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")
  const channelKind = eligible.find(c => c.id === connection)?.kind ?? ""
  const { workspace = "" } = useParams()
  const needsConnection = kind !== "hotmart" && kind !== "api"
  const channelName = initial.connectionKind === "whatsapp" ? "WhatsApp" : initial.connectionKind === "instagram" ? "Instagram" : initial.connectionKind === "telegram" ? "Telegram" : "este canal"
  /** Depois de criar (Hotmart, API, anúncio, direct, carrinho): traz o gatilho novo para o nó e abre o painel dele. */
  async function showCreated(created: { id: string }) {
    const saved = (await listAutomationTriggers(p.automationId!)).find(t => t.id === created.id)
    if (saved) onCreated(saved); else onCancel()
  }
  const handleText = handleLabel[channelKind]
  const missing = !name.trim() ? "Falta dar um nome ao gatilho."
    : kind === "api" && !/^[a-z0-9_]{1,64}$/.test(name.trim()) ? "O nome da entrada usa só letras minúsculas, números e _ (sem espaços nem acentos)."
    : needsConnection && !connection ? "Falta escolher a conexão."
    : kind === "ref_url" && !handle.trim() ? "Falta informar o endereço do link."
    : kind === "message" && !words.length ? "Falta ao menos uma palavra da mensagem."
    : kind === "message" && words.some(w => w.length > 500) ? "Cada palavra pode ter até 500 caracteres."
    : ""
  const canCreate = !p.readOnly && !!p.automationId && !missing
  const conflict = useKeywordConflicts(kind === "message" && words.length && channelKind ? { id: "__novo__", name: name.trim() || "Novo gatilho", channel: channelKind, active: true, audience: "direct", connection_id: connection, rules: [{ condition: "contains", words }] } : null)
  const createRef = React.useRef<() => Promise<boolean>>(async () => false)
  React.useEffect(() => {
    setPendingTrigger({ missing: !p.automationId ? "A automação ainda não foi salva." : missing, submit: () => createRef.current() })
  })
  React.useEffect(() => () => setPendingTrigger(null), [])
  async function create(): Promise<boolean> {
    setSaving(true); setError("")
    if (pendingWord.trim()) { setWords(words); setPendingWord("") }
    try {
      if (kind === "hotmart") {
        const created = await apiRequest<{ id: string }>(`/automations/${encodeURIComponent(p.automationId!)}/triggers`, { method: "POST", body: JSON.stringify({ type: "hotmart", name: name.trim(), node_id: p.node.id, config: { events: hotmartEvents, product_ids: words } }) })
        toast.success("Gatilho Hotmart criado. Registre a URL do webhook em Configurações > Integrações.")
        await showCreated(created); return true
      }
      if (kind === "ad") {
        const created = await apiRequest<{ id: string }>(`/automations/${encodeURIComponent(p.automationId!)}/triggers`, { method: "POST", body: JSON.stringify({ type: "ad", name: name.trim() || "Anúncio", node_id: p.node.id, connection_id: connection, ad_ids: words.filter(w => /^\d+$/.test(w)) }) })
        toast.success("Gatilho de anúncio criado: conversas abertas pelos anúncios escolhidos (ou por qualquer anúncio) começam aqui.")
        await showCreated(created); return true
      }
      if (kind === "ig_share_to_dm") {
        const created = await apiRequest<{ id: string }>(`/automations/${encodeURIComponent(p.automationId!)}/triggers`, { method: "POST", body: JSON.stringify({ type: "ig_share_to_dm", name: name.trim() || "Compartilhou no direct", node_id: p.node.id, connection_id: connection }) })
        toast.success("Gatilho criado: dispara uma vez por contato quando ele compartilha um post ou reel no direct.")
        await showCreated(created); return true
      }
      if (kind === "cart_reply") {
        const created = await apiRequest<{ id: string }>(`/automations/${encodeURIComponent(p.automationId!)}/triggers`, { method: "POST", body: JSON.stringify({ type: "cart_reply", name: name.trim() || "Carrinho", node_id: p.node.id, connection_id: connection }) })
        toast.success("Gatilho de carrinho criado. O pedido fica na variável {{ultimo_carrinho}}.")
        await showCreated(created); return true
      }
      if (kind === "api") {
        const created = await apiRequest<{ id: string }>(`/automations/${encodeURIComponent(p.automationId!)}/triggers`, { method: "POST", body: JSON.stringify({ type: "api", name: name.trim(), node_id: p.node.id }) })
        toast.success(`Entrada externa criada. Dispare com POST /api/public/v1/triggers/fire e trigger_name "${name.trim()}".`)
        await showCreated(created); return true
      }
      const saved = kind === "ref_url"
        ? await createRefTrigger(p.automationId!, { name, connection_id: connection, node_id: p.node.id, handle, text: channelKind === "whatsapp" ? prefill : undefined })
        : kind === "comment" || kind === "live_comment"
        ? await createCommentTrigger(p.automationId!, { name, connection_id: connection, node_id: p.node.id }, kind === "live_comment")
        : kind === "story_reply" || kind === "story_mention"
        ? await createStoryTrigger(p.automationId!, { type: kind === "story_reply" ? "ig_story_reply" : "ig_story_mention", name, connection_id: connection, node_id: p.node.id })
        : await createKeywordTrigger(p.automationId!, { name, connection_id: connection, node_id: p.node.id, words, rule: "contains" })
      onCreated(saved)
      toast.success("Gatilho criado")
      return true
    } catch (e) { setError(e instanceof Error ? e.message : "Não consegui criar o gatilho."); return false }
    finally { setSaving(false) }
  }
  createRef.current = create
  return <div className="space-y-4">
    <h3 className="font-semibold">{triggerCards.find(card => card.kind === kind && card.channel === initial.channel)?.title ?? "Nova entrada da automação"}</h3>
    <div className="space-y-1"><Label htmlFor="trigger-name">Nome do gatilho</Label>
      <Input id="trigger-name" value={name} maxLength={100} disabled={saving} onChange={e => setName(e.target.value)} /></div>
    {!needsConnection ? null : connections.loading ? <p role="status" className="text-sm text-text-muted">Carregando conexões…</p> : connections.error ? <Banner variant="danger">Não consegui carregar as conexões.<Button variant="secondary" size="sm" onClick={connections.reload}>Tentar de novo</Button></Banner> : <>
      <div className="space-y-1"><Label htmlFor="trigger-connection">Conexão</Label>
        <Select value={connection} onValueChange={setConnection} disabled={saving}>
          <SelectTrigger id="trigger-connection"><SelectValue placeholder="Escolha uma conexão" /></SelectTrigger>
          <SelectContent>{eligible.map(c => <SelectItem key={c.id} value={c.id}>{c.displayName ?? c.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {!eligible.length ? <Banner variant="warning">Nenhuma conexão de {channelName} está conectada para esta entrada. <Link className="underline" to={`/${workspace}/settings/channels`}>Conectar um canal em Configurações</Link>.</Banner> : null}
    </>}
    {kind === "ref_url" && handleText ? <div className="space-y-3">
      <div className="space-y-1"><Label htmlFor="new-ref-handle">{handleText.label}</Label>
        <Input id="new-ref-handle" value={handle} maxLength={100} placeholder={handleText.placeholder} disabled={saving} onChange={e => setHandle(e.target.value)} />
        <p className="text-xs text-text-muted">{handleText.hint}</p></div>
      {channelKind === "whatsapp" ? <div className="space-y-1"><Label htmlFor="new-ref-text">Mensagem que já vem escrita</Label>
        <Textarea id="new-ref-text" value={prefill} maxLength={131} rows={3} disabled={saving} onChange={e => setPrefill(e.target.value)} /></div> : null}
      <p className="text-xs text-text-muted">Depois de criar, copie o link ou baixe o QR code.</p></div>
    : kind === "ref_url" ? <p className="text-sm text-text-muted">Escolha a conexão para informar o endereço do link.</p>
    : kind === "hotmart" ? <div className="space-y-1"><p className="text-sm font-medium">Compra aprovada, completa ou carrinho abandonado</p><KeywordChips label="IDs dos produtos (vazio: todos)" placeholder="+ ID do produto" value={chips} onChange={setWords} onPendingChange={setPendingWord} /></div>
    : kind === "ad" ? <div className="space-y-1"><p className="text-sm font-medium">Anúncios que abrem a conversa</p><KeywordChips label="IDs dos anúncios (vazio: qualquer anúncio)" placeholder="+ ID do anúncio" value={chips} onChange={setWords} onPendingChange={setPendingWord} /></div>
    : kind === "message" ? <div className="space-y-1"><p className="text-sm font-medium">A mensagem contém</p><KeywordChips label="Palavras da mensagem" value={chips} onChange={setWords} onPendingChange={setPendingWord} /></div>
      : kind === "comment" ? <p className="text-sm text-text-muted">Depois de criar, escolha a publicação e as palavras dos comentários.</p>
      : kind === "story_reply" ? <p className="text-sm text-text-muted">Depois de criar, escolha o story e a condição da resposta.</p>
      : kind === "story_mention" ? <p className="text-sm text-text-muted">Depois de criar, escolha o atraso e a reação de coração.</p>
      : kind === "api" ? <p className="text-sm text-text-muted">Não precisa de conexão. Um sistema seu dispara a automação pela API pública, chamando <code>POST /api/public/v1/triggers/fire</code> com o nome da entrada (<code>trigger_name</code>). Use só letras minúsculas, números e _.</p>
      : kind === "cart_reply" ? <p className="text-sm text-text-muted">O pedido do carrinho fica na variável {"{{ultimo_carrinho}}"}.</p>
      : null}
    {kind === "message" ? <KeywordConflictNotice conflicts={conflict.conflicts} busy={conflict.busy || saving} onPause={conflict.pause} /> : null}
    <p className="text-xs text-text-muted">O gatilho nasce desligado. Ao publicar a automação, ele é ligado sozinho e passa a disparar.</p>
    {error ? <Banner variant="danger"><span role="alert">{error}</span></Banner> : null}
    {missing && !p.readOnly ? <p role="status" className="text-xs text-text-muted">{missing}</p> : null}
    <div className="flex gap-2"><Button variant="secondary" onClick={onCancel} disabled={saving}>Cancelar</Button>
      <Button onClick={() => void create()} loading={saving} disabled={!canCreate}>Criar gatilho</Button></div>
  </div>
}

const shortRules: Record<TriggerKeywordRule, string> = {
  is: "mensagem é",
  contains: "mensagem contém",
  starts_with: "mensagem começa com",
  word_match: "mensagem contém a palavra inteira",
  does_not_contain: "mensagem não contém",
  thumbs_up: "mensagem é curtir",
  any: "qualquer mensagem",
}

function KeywordDetails({ p, trigger, picker, icon }: { p: PanelProps; trigger: Trigger; picker?: React.ReactNode; icon: React.ReactNode }) {
  const keywords = trigger.keywords ?? []
  const [selected, setSelected] = React.useState(keywords[0]?.id ?? "")
  const keyword = keywords.find(k => k.id === selected) ?? keywords[0]
  if (!keyword) return <SidePanel title={triggerPanelTitle.dm_keyword!} icon={icon} tone="trigger" onClose={p.onClose}>
    {picker}
    <h3 className="break-words text-sm font-semibold">{trigger.name}</h3>
    <p className="text-text-muted">Nenhuma regra de palavra-chave cadastrada para este gatilho.</p>
    <NodeLinks p={p} />
  </SidePanel>
  const recordSelect = keywords.length > 1 ? <div className="space-y-1"><Label htmlFor="keyword-record">Regra de palavra-chave</Label>
    <Select value={keyword.id} onValueChange={setSelected}><SelectTrigger id="keyword-record"><SelectValue /></SelectTrigger>
      <SelectContent>{keywords.map((k, i) => <SelectItem key={k.id} value={k.id}>Regra {i + 1}: {k.words.join(", ") || "Sem palavras"}</SelectItem>)}</SelectContent>
    </Select></div> : null
  return <KeywordForm key={keyword.id} p={p} trigger={trigger} keyword={keyword} picker={picker} icon={icon} recordSelect={recordSelect} />
}

function KeywordForm({ p, trigger, keyword, picker, icon, recordSelect }: { p: PanelProps; trigger: Trigger; keyword: TriggerKeyword; picker?: React.ReactNode; icon: React.ReactNode; recordSelect: React.ReactNode }) {
  const [chips, setWords] = React.useState(keyword.words)
  const [pendingWord, setPendingWord] = React.useState("")
  const words = withPending(chips, pendingWord)
  const [rule, setRule] = React.useState(keyword.rule)
  const [state, setState] = React.useState<TriggerState>(trigger.state ?? (trigger.active ? "active" : "draft"))
  const [repeat, setRepeat] = React.useState<TriggerRepeatMode>(trigger.repeat_mode ?? "every_time")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")
  const unsaved = React.useRef(false)
  // Ao desligar, volta ao estado gravado quando ele não era Ativo (Inicial continua Inicial); vindo de Ativo, vira Rascunho.
  const savedState = trigger.state ?? (trigger.active ? "active" : "draft")
  const supported = keyword.rule in rules && !keyword.parent_id
  const dirty = JSON.stringify(words) !== JSON.stringify(keyword.words) || rule !== keyword.rule || state !== savedState || repeat !== (trigger.repeat_mode ?? "every_time")
  React.useEffect(() => { unsaved.current = dirty }, [dirty])
  React.useEffect(() => () => { if (unsaved.current) toast.warning("As alterações da palavra-chave não foram salvas") }, [])
  const off = p.readOnly || saving
  const keywordOff = off || !supported
  const conflict = useKeywordConflicts(supported && rule !== "group" ? { id: keyword.id, name: trigger.name, channel: trigger.channel_type ?? "", active: true,
    audience: trigger.audience === "group" ? "group" : "direct", connection_id: trigger.channel_id ?? null, case_sensitive: !!keyword.case_sensitive,
    rules: [{ condition: conditionFromEngineRule[rule] ?? "contains", words }] } : null)
  const invalid = supported && rule !== "any" && rule !== "thumbs_up" && (!words.length || words.some(w => !w.trim() || w.length > 500))

  async function save() {
    setSaving(true)
    setError("")
    try {
      const saved = await updateKeywordTrigger(trigger.automation_id, trigger.id, {
        ...(supported && rule !== "group" ? { keyword_id: keyword.id, words, rule } : {}), state, repeat_mode: repeat,
      })
      p.onTriggerChange(saved)
      const fresh = saved.keywords?.find(k => k.id === keyword.id)
      setPendingWord("")
      if (fresh) { setWords(fresh.words); setRule(fresh.rule) } else setWords(words)
      setState(saved.state ?? (saved.active ? "active" : "draft"))
      setRepeat(saved.repeat_mode ?? "every_time")
      unsaved.current = false
      toast.success("Palavra-chave salva")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não consegui salvar a palavra-chave.")
    } finally { setSaving(false) }
  }
  return (
    <SidePanel title={triggerPanelTitle.dm_keyword!} icon={icon} tone="trigger" onClose={p.onClose} footer={
      <PanelFooterBar switchLabel="Gatilho ativo" checked={state === "active"} disabled={off || !p.published} switchHint={!p.published && !p.readOnly ? "Publique para ativar" : undefined} onCheckedChange={on => setState(on ? "active" : savedState !== "active" ? savedState : "draft")}>
        <Button variant="primary" onClick={save} loading={saving} disabled={off || !dirty || invalid}>Salvar</Button>
      </PanelFooterBar>
    }>
      {picker}
      {trigger.audience === "group" ? <p className="text-sm text-text-muted">Grupo: {trigger.group_subject ?? "todos os grupos da conexão"} · {trigger.group_match === "mention" ? "só quando mencionarem o número" : "quando a mensagem tiver a palavra"}. Muda em Palavras-chave.</p> : null}
      {recordSelect}
      {!supported ? <Banner variant="warning">Esta regra composta pode ser consultada, mas sua edição ainda não está disponível.</Banner> : null}
      <div className="space-y-3">
        <div className="flex items-baseline gap-1.5 text-sm">
          <span>Se</span>
          <Label htmlFor="keyword-rule" className="sr-only">Como reconhecer a mensagem</Label>
          <Select value={rule} disabled={keywordOff} onValueChange={v => setRule(v as TriggerKeywordRule)}>
            <SelectTrigger id="keyword-rule" className="h-auto w-auto gap-0 border-0 bg-transparent p-0 text-text-muted underline decoration-text-muted underline-offset-2 hover:border-0 [&>svg]:hidden"><SelectValue>{rule === "group" ? rule : shortRules[rule]}</SelectValue></SelectTrigger>
            <SelectContent>{Object.entries(rules).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {rule === "any" || rule === "thumbs_up" ? <p className="break-words text-sm text-text-muted">{rule === "any" ? "Reconhece qualquer mensagem recebida." : "Reconhece só o polegar para cima (o emoji 👍)."}</p> : keywordOff ? <p className="break-words text-sm">{words.join(", ") || "Sem palavras"}</p> : (
          <KeywordChips label="Palavras da mensagem" value={chips} onChange={setWords} onPendingChange={setPendingWord} />
        )}
        <p className="text-xs text-text-muted">{keyword.case_sensitive ? "As palavras-chave diferenciam maiúsculas e minúsculas." : "As palavras-chave não diferenciam maiúsculas e minúsculas, o que significa que tanto “Olá” quanto “olá” são reconhecidas da mesma maneira."}</p>
      </div>
      <KeywordConflictNotice conflicts={conflict.conflicts} busy={conflict.busy || off} onPause={conflict.pause} />
      {keyword.status !== "live" ? <Banner variant="warning">Esta regra está em rascunho no motor e ainda não dispara a automação.</Banner> : null}
      {error ? <Banner variant="danger"><span role="alert">{error}</span><Button variant="secondary" size="sm" onClick={save} disabled={off || invalid}>Tentar de novo</Button></Banner> : null}
      <MoreOptions>
        <p className="text-xs text-text-muted">Enter, vírgula ou sair do campo adiciona uma palavra. Use até 10 palavras, com até 500 caracteres cada.</p>
      <div className="space-y-1">
        <Label htmlFor="trigger-repeat">Política de disparo</Label>
        <Select value={repeat} disabled={off} onValueChange={v => setRepeat(v as TriggerRepeatMode)}>
          <SelectTrigger id="trigger-repeat"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(triggerPolicies).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
        </Select>
        <p className="text-xs text-text-muted">Só o gatilho ativo dispara{state === "initial" ? " (este está no estado Inicial)" : ""}. A automação também precisa estar ao vivo. Salvar aplica a regra ao gatilho; o mapa é salvo no rascunho.</p>
      </div>
      <NodeLinks p={p} />
      <p className="break-words text-xs text-text-muted">Gatilho: {trigger.name}</p>
      </MoreOptions>
    </SidePanel>
  )
}
