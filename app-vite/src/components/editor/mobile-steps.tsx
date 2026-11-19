import { CardsPreview, isCards } from "./cards-block"
import { describeSmartDelay, describeWindow, describeDate, describeOffset, describeOrigin } from "./temporal"
import { MediaPreview } from "./media-block"
import { mediaLabels } from "./media"
import { isQuickReply } from "./quick-reply-block"
import { isListBlock, listRows } from "./list-block"
import { listSequences } from "@/data/sequences"
import { useAsync } from "@/hooks/use-async"
import { Link } from "react-router"
import { useState, type Dispatch, type SetStateAction } from "react"
import { Pause, Play, Smartphone } from "lucide-react"
import { toast } from "sonner"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/ui/status-badge"
import { rulesBoundTo } from "@/components/keywords/keyword-phrase"
import { listAutomations, listEditorFields, listKeywords, lockedActionsOf, saveDraft, setAutomationStatus, summarizeTrigger, type Automation, type Trigger } from "@/data"
import { listConnections } from "@/data/connections"
import { useCan } from "@/hooks/use-role"
import { needsFirstStep, stepCatalog, type DropItem } from "./connect-drop"
import { FirstStepTitle, StepChoices } from "./connect-drop-menu"
import { availableStepChannels, inferredStepChannel, PENDING_CHANNEL, type StepChannel } from "./step-channel"
import { StepChannelDialog } from "./step-channel-dialog"
import { TriggerMetrics } from "./trigger-metrics"
import { AutomationPreview } from "./automation-preview"
import { annotationLabels } from "./annotations"
import { triggerPolicies, triggerStates } from "./keyword-trigger-panel"
import { describeAction, describeFieldAction, describeDelay, getActions, getBlocks, getDuration, getRules, getVariations, nodeTitle, triggersOf, messageChannel, withFirstStep, type EditableNodeType } from "./graph"

/** Em telas estreitas o editor não cabe: aviso + passos em leitura. */
export function MobileSteps({
  data,
  workspace,
  setAutomation,
}: {
  data: { automation: Automation; triggers: Trigger[]; tags: { id: string; name: string }[] }
  workspace: string
  setAutomation: Dispatch<SetStateAction<Automation>>
}) {
  const { automation, triggers, tags } = data
  const sequences = useAsync(() => listSequences(workspace), workspace)
  const fields = useAsync(() => listEditorFields(workspace), `mobile-fields:${workspace}`)
  const automations = useAsync(() => listAutomations(workspace), `mobile-automations:${workspace}`)
  const keywords = useAsync(() => listKeywords(workspace), `mobile-keywords:${workspace}`)
  const bound = rulesBoundTo(keywords.data ?? [], automation.id)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<number | null>(null)
  // Fluxo só com o gatilho: as mesmas opções agrupadas do cartão "Escolha o primeiro passo" do mapa (mesmo catálogo).
  const admin = useCan("team")
  const canEdit = useCan("edit") && (admin || !lockedActionsOf(automation).includes("edit"))
  const empty = canEdit && needsFirstStep(automation.draft_graph.nodes)
  const connections = useAsync(() => empty ? listConnections(workspace) : Promise.resolve(undefined), `mobile-connections:${workspace}:${empty}`)
  const [creating, setCreating] = useState(false)
  const [askChannel, setAskChannel] = useState<EditableNodeType | null>(null)
  async function createFirstStep(type: EditableNodeType, channel?: StepChannel | typeof PENDING_CHANNEL) {
    if (type === "message" && !channel) {
      const known = inferredStepChannel(undefined, triggers, connections.data)
      if (!known) { setAskChannel(type); return }
      channel = known
    }
    setCreating(true)
    try {
      const { graph } = withFirstStep(automation.draft_graph, type, channel, typeof navigator === "undefined" ? "pt" : navigator.language)
      await saveDraft(automation.id, graph)
      setAutomation(current => ({ ...current, draft_graph: graph, has_unpublished_changes: current.published_version_id !== null }))
      toast.success("Primeiro passo criado. Para editar o conteúdo, abra a automação numa tela maior.")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui criar o passo.")
    } finally { setCreating(false) }
  }
  async function changeStatus() {
    setBusy(true)
    try {
      const updated = await setAutomationStatus(automation.id, automation.status === "stopped" ? "live" : "stopped")
      setAutomation(current => ({ ...current, status: updated.status, updated_at: updated.updated_at }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui mudar o status.")
    } finally { setBusy(false) }
  }
  const nodes = [...automation.draft_graph.nodes].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
  const marks = automation.draft_graph.annotations ?? []
  const automationName = (id: unknown) => typeof id !== "string" || !id ? "a definir" : automations.data?.find(a => a.id === id)?.name ?? (automations.loading ? "(carregando)" : "indisponível")
  const describe = (n: (typeof nodes)[number]) => {
    if (n.type === "trigger") {
      const list = triggersOf({ ...n, data: { config: n.config } }, triggers)
      return list.length ? list.map(t => `${t.name}: ${summarizeTrigger(t)} · ${triggerStates[t.state ?? (t.active ? "active" : "draft")]} · ${triggerPolicies[t.repeat_mode ?? "every_time"]}`).join(" · ") : "Sem configuração"
    }
    if (n.type === "question") return `${n.config.text || "Pergunta vazia"} · Resposta válida / Sem resposta`
    if (n.type === "message") {
      const email = n.config.email as { subject?: string; preheader?: string } | undefined
      if (email) return `E-mail · ${email.subject || "Assunto pendente"} · ${email.preheader || "Prévia pendente"}`
      const texts = getBlocks(n.config).flatMap((b) => (b.kind === "text" ? [b.text] : b.kind === "media" ? [mediaLabels[b.media]] : isCards(b) ? [b.kind === "card" ? "Card" : "Galeria", ...b.cards.map(c => c.title)] : []))
      return `${messageChannel(n.config, triggers)} · ${texts.join(" ") || "Mensagem vazia"}`
    }
    if (n.type === "action")
      return getActions(n.config).map(a => "tag_id" in a ? `${a.type === "add_tag" ? "Adiciona" : "Remove"} a tag ${tags.find(t => t.id === a.tag_id)?.name ?? "—"}` : "sequence_id" in a ? `${a.type === "add_to_sequence" ? "Inscreve na" : "Cancela a"} sequência ${sequences.loading ? "(carregando)" : sequences.error ? "(não foi possível carregar)" : sequences.data?.find(s => s.id === a.sequence_id)?.name ?? "indisponível"}` : (a.type === "set_custom_field_value" || a.type === "unset_custom_field_value") ? describeFieldAction(a, fields.data?.find(f => f.id === a.field_id)?.name ?? a.field_id) : describeAction(a as Parameters<typeof describeAction>[0])).join(". ") || "Sem ações"
    if (n.type === "dynamic") return `Bloco dinâmico · ${n.config.url || "endereço a definir"}`
    if (n.type === "smart_delay") return describeSmartDelay(n.config, describeDelay(getDuration(n.config)), fields.data)
    if (n.type === "condition") return `${getRules(n.config).length} regras · ${n.config.match === "any" ? "basta uma" : "todas devem ser atendidas"}. ${getRules(n.config).map(rule => rule.type === "sequence" ? `${rule.operator === "has" ? "Pertence" : "Não pertence"} à sequência ${sequences.data?.find(s => s.id === rule.sequence_id)?.name ?? "indisponível"}` : rule.type === "origin" ? describeOrigin(rule) : rule.type === "current_time" ? `Horário atual: ${describeWindow(rule.window)}${rule.timezone ? ` · ${rule.timezone}` : ""}` : rule.type === "date" ? `${fields.data?.find(f => f.id === rule.field_id)?.name ?? "Data"} ${rule.operator === "before" ? "antes de" : rule.operator === "after" ? "depois de" : "na mesma data que"} ${describeDate(rule.compare, fields.data)}${describeOffset(rule.offset)}` : "").filter(Boolean).join(". ")}`
    if (n.type === "randomizer") return `${getVariations(n.config).length} caminhos com pesos · ${n.config.random_every_time === false ? "mantém a escolha do contato" : "sorteia a cada passagem"}`
    if (n.type === "start_automation") return `Inicia a automação ${automationName(n.config.automation_id)} e ${n.config.wait_for_finish !== true ? "continua sem esperar" : "espera terminar para continuar"}`
    return "Tipo de passo sem visualização disponível"
  }
  return (
    <div className="space-y-4">
      <Banner variant="warning">Use uma tela maior para editar</Banner>
      {bound.length > 0 ? <p role="status" className="text-sm text-text-muted">{bound.length === 1 ? "Regra de palavra-chave ligada: " : "Regras de palavra-chave ligadas: "}<span className="font-medium text-text">{bound.map(r => `${r.name}${r.active ? "" : " (pausada)"}`).join(", ")}</span>.{" "}<Link to={`/${workspace}/automations/keywords`} className="font-medium text-accent hover:underline">Ver palavras-chave</Link></p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 truncate text-lg font-bold" title={automation.name}>
          {automation.name}
        </h1>
        <StatusBadge status={automation.status} />
      </div>
      {automation.published_version_id ? (
        <Button variant="secondary" onClick={changeStatus} loading={busy}>
          {automation.status === "stopped" ? <Play className="size-4" aria-hidden="true" /> : <Pause className="size-4" aria-hidden="true" />}
          {automation.status === "stopped" ? "Retomar automação" : "Pausar automação"}
        </Button>
      ) : null}
      <Button variant="secondary" aria-pressed={preview !== null} onClick={() => setPreview(p => p === null ? Date.now() : null)}>
        <Smartphone className="size-4" aria-hidden="true" />
        Prévia
      </Button>
      {preview !== null ? (
        <AutomationPreview
          key={preview}
          env={{ graph: automation.draft_graph, catalog: { tags, fields: fields.data ?? [], sequences: sequences.data ?? [], automations: automations.data ?? [] } }}
          issue={sequences.loading || fields.loading || automations.loading ? "Carregando nomes de etiquetas e campos…" : sequences.error || fields.error || automations.error ? "Alguns nomes não carregaram; as notas podem mostrar “sem nome”." : undefined}
          onClose={() => setPreview(null)}
          className="h-128 max-h-[80dvh]"
        />
      ) : null}
      <TriggerMetrics automationId={automation.id} triggers={triggers} workspace={workspace} />
      {nodes.length === 0 ? (
        <p className="text-text-muted">Nenhum passo ainda.</p>
      ) : (
        <ol aria-label="Passos da automação" className="space-y-2">
          {nodes.map((n, i) => (
            <li key={n.id} className="rounded-lg border border-border bg-surface p-3">
              <p className="text-xs font-semibold text-text-muted">
                {i + 1}. {nodeTitle[n.type] ?? n.type}
              </p>
              <p className="break-words">{describe(n)}</p>
              {getBlocks(n.config).filter(b => b.kind === 'button').map(b => <p key={b.id} className="mt-2 break-words text-sm text-text-muted">Botão “{b.label || 'Sem título'}”{b.actions?.length ? ` · ${b.actions.length} ${b.actions.length === 1 ? 'ação ao clicar' : 'ações ao clicar'}` : ''}</p>)}
              {getBlocks(n.config).filter(isQuickReply).map(b => <p key={b.id} className="mt-2 break-words text-sm text-text-muted">{b.skip ? "Pular" : `Resposta rápida “${b.label || 'Sem título'}”`}</p>)}
              {getBlocks(n.config).filter(isListBlock).flatMap(b => listRows(b)).map(r => <p key={r.id} className="mt-2 break-words text-sm text-text-muted">Opção da lista “{r.title || 'Sem título'}”</p>)}
              {getBlocks(n.config).filter(isCards).map((b, i) => <CardsPreview key={`card-${i}`} block={b} />)}
              {getBlocks(n.config).filter(b => b.kind === "media").map((b, i) => <MediaPreview key={i} block={b} />)}
            </li>
          ))}
        </ol>
      )}
      {empty ? (
        <section aria-labelledby="mobile-first-step" className="rounded-lg border-2 border-dashed border-border-input bg-surface px-2 pt-3.5 pb-2">
          <FirstStepTitle id="mobile-first-step" />
          {connections.loading ? <p role="status" className="px-2 py-3 text-sm text-text-muted">Carregando os canais…</p>
            : <StepChoices groups={stepCatalog({ triggers, connections: connections.data }, "first-step")} disabled={creating} className="mt-1.5" onPick={(item: DropItem) => void createFirstStep(item.type, item.channel)} />}
        </section>
      ) : null}
      {askChannel ? <StepChannelDialog channels={availableStepChannels(connections.data)} loading={connections.loading}
        onCancel={() => setAskChannel(null)} onPick={channel => { const type = askChannel; setAskChannel(null); void createFirstStep(type, channel) }} /> : null}
      {marks.length > 0 ? (
        <section aria-labelledby="mobile-marks" className="space-y-2">
          <h2 id="mobile-marks" className="text-sm font-semibold text-text-muted">Notas e grupos do mapa</h2>
          <ul className="space-y-2">
            {marks.map(a => (
              <li key={a.id} className="rounded-lg border border-dashed border-border bg-surface-muted p-3">
                <p className="text-xs font-semibold text-text-muted">{annotationLabels[a.kind]}</p>
                <p className="whitespace-pre-wrap break-words">{(a.kind === "note" ? a.text : a.title) || (a.kind === "note" ? "Nota sem texto" : "Grupo sem título")}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Button asChild variant="secondary">
        <Link to={`/${workspace}/automations`}>Voltar para a lista</Link>
      </Button>
    </div>
  )
}
