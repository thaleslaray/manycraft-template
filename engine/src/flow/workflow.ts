import { z } from 'zod'
import { saveMessageCallback } from './message-callback'
import { deliverCommentOpening } from '../channels/core/comment-delivery'
import { isCards, cardsMessage, cardsError, mergeLeadText } from '../schemas/message-cards'
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import { storedMedia } from '../media-blocks'
import { mediaError } from '../schemas/message-media'
import { isQuickReply, quickRepliesError, quickReplyWaitMs } from '../schemas/message-quick-replies'
import { isListBlock, listError, listRows, mapListText } from '../schemas/message-list'
import { notifyTimeline, ensureConversation, recordMessage } from '../inbox/service'
import { delayDeadline } from './timing'
import { canSend } from '../channels/policy'
import { marketingBlocked, prepareTemplateMessage } from '../inbox/template-message'
import { messageNodeTypes, validateGraph } from '../schemas/graph'
import { contactVariableRenderer } from '../db/message-variables'
import { channelMismatch } from './step-channel'
import { actions, condition, milliseconds, metric, randomize, startAutomation, messageSchema, waitsForCall, callState, notifyParent } from './nodes'
import { connectionAdapter, RateLimited, type Button, type ChannelType, type Degradation, type OutboundMessage, type QuickReply, type SendResult } from '../channels'
import { storedConnection } from '../channels/core/delivery'
import { shortenLinks } from './link-click'
import type { FlowEnv, FlowParams, Run } from './types'
import { assertRunActive } from './state'
import { flowLinkUrl } from './link-click'
import { executeQuestion } from './questions'
import { sequenceRunActive } from './sequences'
import { runStoryPrelude } from './story-effects'
import { moveRun } from './run-state'
import { CONNECTION_WAIT_MAX_MS, connectionRefusalNow, connectionWaitCode, waitForConnection } from './connection-wait'
import { inlineResults, replayStep } from './inline'
import { currentTiming, inlineMemo, writeSoon } from './inline-timing'
import { callDynamic, dynamicActions, dynamicBlocks, dynamicConfigSchema, fullContactData } from './dynamic-block'

export class FlowRun extends WorkflowEntrypoint<FlowEnv, FlowParams> {
  async run(event: WorkflowEvent<FlowParams>, step: WorkflowStep) {
    // Passos já executados em linha pelo caminho rápido do webhook voltam com o mesmo resultado (nunca se repetem).
    const done = await step.do('inline-cache', async () => inlineResults(this.env, event.payload.runId))
    return runFlow(this.env, event.payload.runId, done.length ? replayStep(step, done) : step)
  }
}

/** O executor de uma execução: o mesmo para o Workflow e para os primeiros passos em linha (flow/inline.ts). */
export async function runFlow(env: FlowEnv, runId: string, step: WorkflowStep) {
  {
    try {
      const run = await step.do('load', async () => {
        // As duas leituras são independentes: uma ida em paralelo.
        const [, row] = await Promise.all([assertRunActive(env, runId), env.DB.prepare(`SELECT r.*,v.graph,v.automation_id,cc.external_user_id,ch.type AS channel_type,gt.external_group_id AS reply_group_jid
          FROM flow_runs r JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id
          JOIN contact_channels cc ON cc.workspace_id=r.workspace_id AND cc.contact_id=r.contact_id AND cc.channel_id=r.channel_id
          JOIN channels ch ON ch.workspace_id=r.workspace_id AND ch.id=r.channel_id
          LEFT JOIN group_threads gt ON gt.workspace_id=r.workspace_id AND gt.id=r.reply_group_thread_id
          WHERE r.id=? AND ch.status='connected'`).bind(runId).first<Run>()])
        if (!row) throw new NonRetryableError('Flow run or connected channel missing')
        // The entire snapshot is the step result: no mutable draft/publication reads on resume.
        return row
      })
      // Pausa do atendimento humano para o contato (lida em cada pause-check; em linha, uma leitura serve aos passos repetíveis seguidos).
      const contactPause = () => inlineMemo(`v:paused:${run.workspace_id}:${run.contact_id}`, () => env.DB.prepare('SELECT automation_paused_until FROM contacts WHERE workspace_id=? AND id=?')
        .bind(run.workspace_id, run.contact_id).first<{ automation_paused_until: number | null }>())
      // Em linha: as leituras do primeiro pause-check começam já, em paralelo com as próximas (no Workflow nada muda).
      // Dados do contato para personalizar (em linha, a leitura começa já e serve ao primeiro personalize; um passo com efeito a renova).
      const contactRender = () => inlineMemo(`v:render:${run.workspace_id}:${run.contact_id}`, () => contactVariableRenderer(env.DB, run.workspace_id, run.contact_id))
      if (currentTiming()) { sequenceRunActive(env, run.id).catch(() => undefined); contactPause().catch(() => undefined); contactRender().catch(() => undefined) }
      // Runs paused before the adapter rollout have a cached load result without channel_type.
      run.channel_type ??= await step.do('channel-type', async () => {
        const channel = await env.DB.prepare('SELECT type FROM channels WHERE workspace_id=? AND id=?')
          .bind(run.workspace_id, run.channel_id).first<{ type: string }>()
        if (!channel) throw new NonRetryableError('Flow channel missing')
        return channel.type
      })
      // The connection that started the run says which provider sends: the engine never names one.
      const adapter = await connectionAdapter(env, run.workspace_id, run.channel_id, run.channel_type)
      // The connection's own profile (override included) splits the text, so the adapter's own fit finds nothing left to split
      // and no part is renumbered or lost.
      const caps = (await storedConnection(env, run.channel_type as ChannelType, run.workspace_id, run.channel_id)).profile
      const graph = validateGraph(JSON.parse(run.graph))
      // Automação pausada só para este contato: o run novo não começa.
      const paused = await step.do('paused-check', async () => !!await env.DB.prepare(`SELECT 1 FROM contact_automation_pauses
        WHERE workspace_id=? AND contact_id=? AND automation_id IN (?,?) AND paused_until>?`).bind(run.workspace_id, run.contact_id, run.automation_id,
        runId.startsWith('rule-') ? 'scope:rules' : runId.startsWith('sequence-') ? 'scope:sequences' : run.automation_id, Date.now()).first())
      if (paused) {
        await step.do('paused-cancel', async () => {
          await moveRun(env.DB, runId, 'cancelled', { error: 'automation_paused' }).run()
          await notifyParent(env, runId)
        })
        return { runId, status: 'cancelled' }
      }
      if (run.story_context) await runStoryPrelude(env, step, run)
      const degraded: { nodeId: string; changes: Degradation[] }[] = []
      let stepsSincePause = 0
      // A primeira mensagem de uma execução nascida de comentário sai como resposta privada (outro transporte, sem janela); as seguintes são DMs comuns.
      let commentOpening = !!run.comment_context
      let nodeId: string | undefined = run.start_node_id ?? graph.nodes.find(n => ['trigger','starting_step'].includes(n.type))?.id ?? graph.nodes[0]?.id
      const next = (id: string, ...ports: string[]) => {
        for (const port of ports) {
          const edges = graph.edges.filter(e => e.from === id && e.port === port)
          if (edges.length > 1) throw new NonRetryableError('Ambiguous graph port')
          if (edges.length) return edges[0].to
        }
        return undefined
      }
      // A link button with an exit, or with actions on click, opens the address through a tracked redirect: the click runs the actions and continues along the exit.
      const followsLink = (from: string, b: { id: string; action: { type: string }; actions?: unknown[] }) => b.action.type === 'url'
        && (!!b.actions?.length || graph.edges.some(e => e.from === from && (e.port === `btn:${b.id}` || e.port === b.id)))
      for (let index = 0; nodeId; index++) {
        const found = graph.nodes.find(n => n.id === nodeId)
        if (!found) throw new NonRetryableError('Flow node missing')
        let node: typeof found = found
        // Check live human handoff state again after delays/clicks, rather than trusting the frozen graph snapshot.
        for (let pause = 0; ; pause++) {
          const until = await step.do(`pause-check:${index}:${pause}`, async () => {
            // Três leituras independentes numa ida (em linha, passos repetíveis seguidos reaproveitam a leitura: inlineMemo).
            const [, active, contact] = await Promise.all([assertRunActive(env, runId), sequenceRunActive(env, run.id), contactPause()])
            if (!active) throw new NonRetryableError('Sequence enrollment cancelled')
            const end = contact?.automation_paused_until ?? 0
            if (run.system_confirmation || end <= Date.now()) return null
            await moveRun(env.DB, run.id, 'waiting_delay', { waitReason: 'human_pause', waitUntil: end }).run()
            return end
          })
          if (until === null) break
          stepsSincePause = 0
          try {
            await step.waitForEvent(`human-pause:${index}:${pause}`, {
              type: 'automation_resume', timeout: Math.max(1000, until - Date.now()),
            })
          } catch { /* Pause elapsed; re-read live state before continuing. */ }
        }
        if (index > 0 || !['trigger', 'starting_step'].includes(node.type)) {
          if (stepsSincePause >= 30) {
            await step.do(`safety-pause:${index}`, async () => {
              await assertRunActive(env, runId)
              await moveRun(env.DB, runId, 'waiting_delay', { waitReason: 'safety_pause', currentNodeId: node.id, error: 'consecutive_block_limit' }).run()
              await notifyTimeline(env, run.workspace_id)
              await notifyParent(env, runId)   // quem espera esta execução (Iniciar automação) pausa junto, em vez de esperar para sempre
            })
            return { runId, status: 'paused', reason: 'consecutive_block_limit' }
          }
          stepsSincePause++
        }
        await step.do(`enter:${index}`, async () => {
          const [, active] = await Promise.all([assertRunActive(env, runId), sequenceRunActive(env, run.id)])
          if (!active) throw new NonRetryableError('Sequence enrollment cancelled')
          // Em linha, a mudança de passo vai ao banco no lote do próximo passo com efeito (writeSoon); no Workflow, na hora.
          await writeSoon(moveRun(env.DB, run.id, 'running', { currentNodeId: node.id, stepsSincePause }))
        })
        let port = 'next'
        // Bloco dinâmico: o servidor do cliente devolve o conteúdo; as ações rodam e as mensagens seguem como uma mensagem comum.
        if (node.type === 'dynamic') {
          const current = node
          const outcome = await step.do(`dynamic:${index}`, async () => {
            await assertRunActive(env, runId)
            const config = dynamicConfigSchema.parse(current.config)
            try {
              const contact = await fullContactData(env.DB, run.workspace_id, run.contact_id)
              const render = await contactVariableRenderer(env.DB, run.workspace_id, run.contact_id)
              const response = await callDynamic(env, render(config.url), { contact, automation_id: run.automation_id, node_id: current.id }, fetch, {
                method: config.method, headers: Object.fromEntries(config.headers.map(h => [h.name, render(h.value)])),
                ...(config.body ? { rawBody: render(config.body.replaceAll('{{full_contact_data}}', JSON.stringify(contact))) } : {}) })
              const list = await dynamicActions(env.DB, run.workspace_id, response)
              if (list.length) await actions(env, run, { actions: list }, index)
              if (response.content.external_message_callback) await saveMessageCallback(env.DB, run.workspace_id, run.contact_id, run.channel_id, response.content.external_message_callback)
              return { blocks: JSON.stringify(dynamicBlocks(response)), error: null as string | null }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Falha no bloco dinâmico.'
              await env.DB.prepare(`INSERT INTO external_request_logs (id,workspace_id,automation_id,node_id,run_id,contact_id,source,method,target,status,outcome,error_code,message,duration_ms)
                VALUES (?,?,?,?,?,?,'run','POST',?,NULL,'error','dynamic',?,0) ON CONFLICT(id) DO NOTHING`)
                .bind(`dynamic-${runId}-${index}`, run.workspace_id, run.automation_id, current.id, run.id, run.contact_id, config.url.replace(/^(https?:\/\/[^/?#]*).*$/i, '$1'), message).run()
              return { blocks: JSON.stringify(config.fallback_text ? [{ kind: 'text', text: config.fallback_text }] : []), error: message }
            }
          })
          const blocks = JSON.parse(outcome.blocks) as Record<string, unknown>[]
          if (!blocks.length) { nodeId = next(node.id, ...(outcome.error ? ['error'] : []), 'next'); continue }
          node = { ...current, type: 'message', config: { blocks } as typeof current.config }
        }
        // Modelo aprovado: o único envio aceito fora da janela de conversa do canal. Dentro da janela também vale.
        if (node.type === 'template_message') {
          const current = node
          // Canal sem modelos: o passo não tem como enviar. Falha já, com código próprio, em vez de tentar e cair no erro genérico.
          if (!caps.templates) throw new NonRetryableError('Template step unsupported on channel')
          const sendTemplate = (name: string) => step.do(name, { retries: { limit: 5, delay: ({ error }) => error instanceof RateLimited ? error.retryAfter * 1000 : 1000 }, timeout: '30 seconds' }, async () => {
            await assertRunActive(env, runId)
            const input = z.object({ template_id: z.string().min(1), params: z.record(z.string(), z.string()).default({}) }).parse(current.config)
            const render = await contactVariableRenderer(env.DB, run.workspace_id, run.contact_id)
            const prepared = await prepareTemplateMessage(env, run.workspace_id, run.channel_id, { id: input.template_id, params: Object.fromEntries(Object.entries(input.params).map(([k, v]) => [k, render(v)])) })
            if (await marketingBlocked(env, run.workspace_id, run.channel_id, run.external_user_id, prepared.message)) throw new NonRetryableError('Marketing opt-out')
            const state = await env.DB.prepare(`SELECT cc.opted_in,cc.window_expires_at,cc.human_window_expires_at,cc.blocked_at,c.status FROM contact_channels cc JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id
              WHERE cc.workspace_id=? AND cc.contact_id=? AND cc.channel_id=?`).bind(run.workspace_id, run.contact_id, run.channel_id)
              .first<{ opted_in: number; window_expires_at: number | null; human_window_expires_at: number | null; blocked_at: number | null; status: string }>()
            if (!state) throw new NonRetryableError('Contact channel state missing')
            const mode = canSend({ ...caps, commentReply: null }, { optedIn: state.opted_in === 1 && state.status === 'subscribed', windowExpiresAt: state.window_expires_at, humanWindowExpiresAt: state.human_window_expires_at, blocked: state.blocked_at !== null }, Date.now(), 'automation')
            if (!mode.ok && !(mode.reason === 'outside_window' && caps.templates)) throw new ChannelSendFailure(mode)
            const result = await adapter.send({ run, runId: run.id, step: index, part: 0, channelId: run.channel_id, externalUserId: run.external_user_id, mode }, prepared.message)
            if (!result.ok) {
              if (result.reason === 'rate_limited') throw new RateLimited(result.retryAfterSec)
              const wait = connectionWaitCode(result)
              if (wait) return wait
              throw new ChannelSendFailure(result)
            }
            await metric(env, run, current.id, 'sent')
            return null
          })
          // O modelo é justamente o envio que inicia conversa: com o número restrito (ou a conexão fora do ar), espera o conserto.
          let deadline: number | undefined
          for (let w = 0; ; w++) {
            const wait = await sendTemplate(w ? `template:${index}:w${w}` : `template:${index}`)
            if (!wait) break
            deadline ??= await step.do(`connection-deadline:template:${index}`, async () => Date.now() + CONNECTION_WAIT_MAX_MS)
            await waitForConnection(env, step, run, `template:${index}:${w}`, deadline, wait)
          }
          nodeId = next(node.id, 'next'); continue
        }
        // Passo de outro canal: segue pela saída sem enviar e grava o motivo.
        if (messageNodeTypes.includes(node.type) && channelMismatch((node.config as Record<string, unknown>).channel, run.channel_type)) {
          const skipped = node
          await step.do(`channel-skip:${index}`, async () => {
            await assertRunActive(env, runId)
            await env.DB.prepare(`INSERT INTO flow_step_skips (run_id,step_index,workspace_id,automation_id,node_id,reason,step_channel,run_channel)
              VALUES (?,?,?,?,?,'channel_mismatch',?,?) ON CONFLICT DO NOTHING`)
              .bind(run.id, index, run.workspace_id, run.automation_id, skipped.id, String((skipped.config as Record<string, unknown>).channel), run.channel_type).run()
          })
          nodeId = next(node.id, 'next'); continue
        }
        if (messageNodeTypes.includes(node.type)) {
          const config = messageSchema.parse(node.config)
          // Encurtador ligado na conexão: links do corpo do texto viram links curtos com clique contado.
          const shorten = (await storedConnection(env, run.channel_type as ChannelType, run.workspace_id, run.channel_id)).settings.shortenLinks === true
          config.blocks = await step.do(`personalize:${index}`, async () => {
            const baseRender = await contactRender()
            const render = baseRender
            // Cada bloco com as variáveis do contato aplicadas (cartões: título, textos, links e botões; texto: links encurtados se pedido).
            const renderCard = (c: Extract<typeof config.blocks[number], { cards: unknown }>['cards'][number]) => ({ ...c, title: render(c.title),
              subtitle: c.subtitle ? render(c.subtitle) : undefined, imageUrl: c.imageUrl ? render(c.imageUrl) : undefined, actionUrl: c.actionUrl ? render(c.actionUrl) : undefined,
              buttons: c.buttons?.map(button => ({ ...button, title: render(button.title),
                ...(button.type === 'url' ? { url: render(button.url) } : button.type === 'postback' ? { id: render(button.id) } : { phone: render(button.phone) }) })) })
            return Promise.all(config.blocks.map(async b =>
              isCards(b) ? { ...b, cards: b.cards.map(renderCard) }
              : b.kind === 'media' ? storedMedia(env, run.workspace_id, { ...b, url: render(b.url) })
              : b.kind === 'text' ? { ...b, text: shorten ? await shortenLinks(env, run, node.id, render(b.text)) : render(b.text) }
              : b.kind === 'typing' ? b
              : isListBlock(b) ? mapListText(b, render)
              : { ...b, label: render(b.label) }))
          })
          // O perfil da conexão que valida e corta a mensagem fica guardado no passo: quando o Workflow retoma (ou repete) o envio,
          // as partes já entregues não são revalidadas com um limite que mudou no meio (a foto entregue não vira falha).
          const stepCaps = await step.do(`profile:${index}`, async () => caps)
          const opening = commentOpening
          // A resposta privada tem janela própria da Meta (dias contados do comentário): a espera pela conexão não passa dela.
          const commentEnd = opening && stepCaps.commentReply ? (JSON.parse(run.comment_context!) as { createdAt: number }).createdAt + stepCaps.commentReply.maxAgeDays * 86_400_000 : undefined
          const texts = config.blocks.filter(b => b.kind === 'text')
          const buttons = config.blocks.filter(b => b.kind === 'button')
          const quicks = config.blocks.filter(isQuickReply)
          const list = config.blocks.find(isListBlock)
          const listItems = list ? listRows(list) : []
          if ((!texts.length && !config.blocks.some(b => b.kind === 'media' || isCards(b))) || buttons.length > 100 || new Set(buttons.map(b => b.id)).size !== buttons.length) {
            throw new NonRetryableError('Invalid channel message blocks')
          }
          // Quick replies follow the effective profile: a connection without them (or with fewer slots) is a publication error, never a silent cut.
          const quickError = quickRepliesError(config.blocks, [stepCaps], config)
          if (quickError) throw new NonRetryableError(quickError)
          // A list of options follows the effective profile too; every row becomes a tap with its own token and exit.
          const listIssue = listError(config.blocks, [stepCaps])
          if (listIssue) throw new NonRetryableError(listIssue)
          const quickWait = quickReplyWaitMs(config), quickAttempts = quicks.length ? config.reply_attempts ?? 1 : 1
          const timeout = quicks.length ? quickWait : milliseconds(config.click_timeout ?? { value: 23, unit: 'hours' })
          const tokens = await step.do(`tokens:${index}`, async () => {
            await assertRunActive(env, runId)
            const expires = Date.now() + (quicks.length ? quickWait * quickAttempts : timeout)
            const tapped = [...buttons.filter(b => b.action.type === 'go_to_node' || b.action.type === 'dynamic' || b.action.type === 'start_automation' || followsLink(node.id, b)), ...quicks, ...listItems]
            // Sem botão com volta, não há ficha a criar nem a ler.
            if (!tapped.length) return []
            for (const button of tapped) {
              const token = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')
              await env.DB.prepare(`INSERT INTO button_tokens (token,workspace_id,run_id,node_id,step_index,button_id,expires_at,target_url)
                VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(run_id,step_index,button_id) DO NOTHING`)
                .bind(token, run.workspace_id, run.id, node.id, index, button.id, expires, 'action' in button && button.action.type === 'url' ? button.action.url : null).run()
            }
            const rows = await env.DB.prepare('SELECT token,button_id,expires_at FROM button_tokens WHERE run_id=? AND step_index=?')
              .bind(run.id, index).all<{ token: string; button_id: string; expires_at: number }>()
            return rows.results
          })
          const neutralButtons: Button[] = buttons.map(b => b.action.type === 'url'
            ? { type: 'url', title: b.label, url: followsLink(node.id, b) ? flowLinkUrl(env, tokens.find(t => t.button_id === b.id)!.token) : b.action.url,
              ...(b.action.webview_size ? { webviewSize: b.action.webview_size } : {}) }
            : { type: 'postback', title: b.label, id: `b:${tokens.find(t => t.button_id === b.id)!.token}` })
          const neutralQuick: QuickReply[] = quicks.map(q => ({ title: q.label, id: `b:${tokens.find(t => t.button_id === q.id)!.token}` }))
          const neutralList = list ? { kind: 'list' as const, buttonText: list.buttonText, sections: list.sections.map(s => ({ ...(s.title ? { title: s.title } : {}),
            rows: s.rows.map(r => ({ id: `b:${tokens.find(t => t.button_id === r.id)!.token}`, title: r.title, ...(r.description ? { description: r.description } : {}) })) })) } : undefined
          // Validate and fit every part before any network side effect. Capabilities drive limits, never channel names.
          // Each block remembers the pause (typing) that comes before it; the pause only runs in the flow, never in a dry check.
          const changes: Degradation[] = []
          const sendable: { block: Exclude<typeof config.blocks[number], { kind: 'button' | 'typing' | 'quick_reply' | 'list' }>; typing: number }[] = []
          let typingBefore = 0
          // A gallery that the channel sends as a carousel takes the text right before it as its opening message.
          for (const block of mergeLeadText(config.blocks, stepCaps)) {
            if (block.kind === 'typing') typingBefore += block.seconds
            else if (block.kind === 'text' || block.kind === 'media' || isCards(block)) { sendable.push({ block, typing: typingBefore }); typingBefore = 0 }
          }
          if ((buttons.length || quicks.length || list) && sendable.at(-1)?.block.kind !== 'text') { sendable.push({ block: { kind: 'text', text: 'Escolha uma opção:' }, typing: typingBefore }); typingBefore = 0 }
          const plan = sendable.flatMap(({ block, typing }, i) => {
            if (block.kind === 'media') {
              const error = mediaError(block, [stepCaps], false)
              if (error) throw new NonRetryableError(error)
            }
            if (isCards(block)) { const error = cardsError(block, [stepCaps], false); if (error) throw new NonRetryableError(error) }
            const fitted = adapter.fit(isCards(block) ? cardsMessage(block) : block.kind === 'media' ? { kind: 'media', media: block.media, url: block.url, size: block.size, mime: block.mime } : i === sendable.length - 1 && neutralList ? { ...neutralList, text: block.text } : { kind: 'text', text: block.text,
              ...(i === sendable.length - 1 ? { buttons: neutralButtons, ...(neutralQuick.length ? { quickReplies: neutralQuick } : {}) } : {}) }, stepCaps)
            if ('ok' in fitted) throw new ChannelSendFailure(fitted)
            changes.push(...fitted.degraded)
            return fitted.messages.map((message, part) => ({ message, typing: part === 0 ? typing : 0 }))
          })
          const messages = plan.map(entry => entry.message)
          // Groups break at every pause: [typing → send] repeats; the first group keeps the original step names.
          const groups: { typing: number; first: number; messages: OutboundMessage[] }[] = []
          for (const [i, entry] of plan.entries()) {
            if (!groups.length || entry.typing > 0) groups.push({ typing: entry.typing, first: i, messages: [] })
            groups.at(-1)!.messages.push(entry.message)
          }
          const inboxButtons = [...buttons.map((b, i) => ({ id: b.id, title: b.label, payload: neutralButtons[i].type === 'postback' ? neutralButtons[i].id : undefined })),
            ...quicks.map((q, i) => ({ id: q.id, title: q.label, payload: neutralQuick[i].id })),
            ...listItems.map(r => ({ id: r.id, title: r.title, payload: `b:${tokens.find(t => t.button_id === r.id)!.token}` }))]
          const sendGroup = async (name: string, list: OutboundMessage[], firstPart: number) => {
            return step.do(name, {
              retries: { limit: 5, delay: ({ error }) => error instanceof RateLimited ? error.retryAfter * 1000 : 1000 }, timeout: '30 seconds',
            }, async () => {
              const readState = () => env.DB.prepare(`SELECT cc.opted_in,cc.window_expires_at,cc.human_window_expires_at,cc.last_inbound_at,cc.blocked_at,c.status
                  FROM contact_channels cc JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id
                  JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
                  WHERE cc.workspace_id=? AND cc.contact_id=? AND cc.channel_id=? AND ch.archived_at IS NULL AND ch.type=?`)
                  .bind(run.workspace_id, run.contact_id, run.channel_id, run.channel_type)
                  .first<{ opted_in: number; window_expires_at: number | null; human_window_expires_at: number | null; last_inbound_at: number | null; blocked_at: number | null; status: string }>()
              // Primeira parte: run ativo, inscrição na sequência e estado do contato são leituras independentes, numa ida só.
              const [, firstActive, firstState] = await Promise.all([assertRunActive(env, runId), sequenceRunActive(env, run.id), opening ? undefined : readState()])
              for (const [offset, message] of list.entries()) {
                const part = firstPart + offset
                if (!(offset === 0 ? firstActive : await sequenceRunActive(env, run.id))) throw new NonRetryableError('Sequence enrollment cancelled')
                if (opening) {
                  // Resposta privada ao comentário: uma mensagem só (texto e até um botão); sem opt-in nem janela de DM.
                  if (messages.length !== 1) throw new NonRetryableError('Channel send failed: unsupported: Private reply is a single message')
                  const tap = neutralButtons[0]
                  // Janela vencida (inclusive depois de esperar a conexão): falha com o motivo dela, antes de olhar a conexão.
                  if (commentEnd !== undefined && commentEnd <= Date.now()) throw new ChannelSendFailure({ ok: false, reason: 'comment_too_old' })
                  // Conexão fora do ar, desligada pela equipe ou restrita: espera como a mensagem comum. O comentário conta como a mensagem do
                  // contato para a janela da restrita.
                  const refused = await connectionRefusalNow(env, run, caps, commentEnd === undefined ? null : (JSON.parse(run.comment_context!) as { createdAt: number }).createdAt)
                  const down = refused ? connectionWaitCode(refused) : null
                  if (down) return { parts: offset, degraded: changes, wait: down, clicked: false }
                  const result = await deliverCommentOpening(env, run, index, config.blocks, { nodeId: node.id,
                    ...(tap?.type === 'postback' ? { button: { type: 'postback' as const, id: tap.id } } : tap?.type === 'url' ? { button: { type: 'url' as const, url: tap.url } } : {}) })
                  if (!result.ok) {
                    if (result.reason === 'rate_limited') throw new RateLimited(result.retryAfterSec)
                    throw new ChannelSendFailure(result)
                  }
                  continue
                }
                const state = offset === 0 && firstState !== undefined ? firstState : await readState()
                // Desligada pela equipe não some daqui: a entrega recusa com connection_unavailable e a execução espera ser religada (arquivada falha).
                if (!state) throw new NonRetryableError('Contact channel state missing')
                // A run born in a group answers in the group: no private conversation is involved, so the contact's consent to direct messages
                // and window do not apply. The connection must support replying in groups, and the contact must still be subscribed.
                if (run.reply_group_jid && (!caps.groups?.reply || state.status !== 'subscribed')) {
                  throw new ChannelSendFailure({ ok: false, reason: 'unsupported', detail: 'Connection cannot answer in groups' })
                }
                const mode = run.reply_group_jid ? { ok: true as const, mode: 'free' as const }
                  : canSend({ ...caps, commentReply: null }, { optedIn: (state.opted_in === 1 || run.system_confirmation === 'system_opt_out') && state.status === 'subscribed',
                  windowExpiresAt: caps.window && state.last_inbound_at !== null ? Math.min(state.window_expires_at ?? 0, state.last_inbound_at + caps.window.standardHours * 3600000) : state.window_expires_at, humanWindowExpiresAt: state.human_window_expires_at, blocked: state.blocked_at !== null }, Date.now(), 'automation')
                if (!mode.ok) throw new ChannelSendFailure(mode)
                const result = await adapter.send({ run, runId: run.id, step: index, part, channelId: run.channel_id,
                  externalUserId: run.external_user_id, mode,
                  ...(run.reply_group_jid && run.reply_group_thread_id ? { group: { threadId: run.reply_group_thread_id, externalGroupId: run.reply_group_jid } } : {}),
                  inboxButtons }, message)
                if (!result.ok) {
                  if (result.reason === 'rate_limited') throw new RateLimited(result.retryAfterSec)
                  // A conexão recusou (restrita para iniciar conversa, ou fora do ar): a execução espera o conserto em vez de falhar.
                  const wait = connectionWaitCode(result)
                  if (wait) return { parts: offset, degraded: changes, wait, clicked: false }
                  throw new ChannelSendFailure(result)
                }
              }
              // Durable step output retains degradation details without inventing node_events columns/types.
              return { parts: list.length, degraded: changes, wait: null as 'connection_restricted' | 'connection_unavailable' | null, clicked: false }
            })
          }
          // Each retry after the wait is a new durable step; parts already sent are kept by their claim (flow_outbound) and never go twice.
          // Validade dos botões: nasce em tokens:<i>; uma espera pela conexão (que pode levar dias) a renova antes do reenvio.
          let tokensExpireAt = tokens[0]?.expires_at
          // `untilClicked`: lembrete das respostas rápidas. Um toque durante a espera da conexão (dispatch.ts aceita o clique e acorda a espera)
          // encerra o lembrete sem reenviá-lo; o clique fica guardado para o waitForEvent seguinte.
          const sendWaiting = async (name: string, list: OutboundMessage[], firstPart: number, untilClicked = false) => {
            let deadline: number | undefined
            for (let w = 0; ; w++) {
              const sent = await sendGroup(w ? `${name}:w${w}` : name, list, firstPart)
              if (!sent.wait) return sent
              deadline ??= await step.do(`connection-deadline:${name}`, async () => Math.min(Date.now() + CONNECTION_WAIT_MAX_MS, commentEnd ?? Infinity))
              await waitForConnection(env, step, run, `${name}:${w}`, deadline, sent.wait)
              if (untilClicked && await step.do(`click-check:${name}:${w}`, async () => !!await env.DB.prepare('SELECT 1 FROM flow_clicks WHERE run_id=? AND step_index=?')
                .bind(run.id, index).first())) return { ...sent, wait: null, clicked: true }
              // Os botões voltam a valer o prazo inteiro a partir de agora, antes de a mensagem sair de novo (um clique logo depois do envio vale).
              if (tokens.length) tokensExpireAt = await step.do(`tokens-renew:${name}:${w}`, async () => {
                await assertRunActive(env, runId)
                const expires = Date.now() + (quicks.length ? quickWait * quickAttempts : timeout)
                await env.DB.prepare('UPDATE button_tokens SET expires_at=? WHERE run_id=? AND step_index=?').bind(expires, run.id, index).run()
                return expires
              })
            }
          }
          // The pause shows the indicator only when the effective profile declares it, in slices the profile allows; the wait happens either way.
          const pause = async (seconds: number, tag: string) => {
            const slice = caps.typing?.maxSeconds ?? seconds
            for (let left = seconds, k = 0; left > 0; k++) {
              const chunk = Math.min(left, slice)
              if (caps.typing) await step.do(`typing:${tag}:${k}`, { retries: { limit: 3, delay: ({ error }) => error instanceof RateLimited ? error.retryAfter * 1000 : 1000 }, timeout: '15 seconds' }, async () => {
                await assertRunActive(env, runId)
                const result = await adapter.send({ run, runId: run.id, step: index, part: 0, channelId: run.channel_id, externalUserId: run.external_user_id,
                  mode: { ok: true, mode: 'free' }, ...(run.reply_group_jid && run.reply_group_thread_id ? { group: { threadId: run.reply_group_thread_id, externalGroupId: run.reply_group_jid } } : {}) },
                  { kind: 'typing', seconds: chunk })
                if (!result.ok && result.reason === 'rate_limited') throw new RateLimited(result.retryAfterSec)
                return result.ok
              })
              await step.sleep(`typing-wait:${tag}:${k}`, chunk * 1000)
              left -= chunk
            }
          }
          let delivery: { parts: number; degraded: Degradation[] } | undefined
          for (const [g, group] of groups.entries()) {
            if (group.typing > 0) await pause(group.typing, `${index}:${g}`)
            const sent = await sendWaiting(g === 0 ? `send:${index}` : `send:${index}:g${g}`, group.messages, group.first)
            if (g === 0) delivery = sent
          }
          if (typingBefore > 0) await pause(typingBefore, `${index}:end`)
          commentOpening = false
          if (delivery?.degraded.length) degraded.push({ nodeId: node.id, changes: delivery.degraded })
          await step.do(`sent:${index}`, async () => { await assertRunActive(env, runId); await metric(env, run, node.id, 'sent') })
          if (tokens.length) {
            stepsSincePause = 0
            let clicked: { token: string } | undefined
            for (let attempt = 0; attempt < quickAttempts && !clicked; attempt++) {
              // A reminder resends only the message that carries the quick replies; the reply tokens stay the same.
              const reminder = attempt > 0 ? await sendWaiting(`send:${index}:r${attempt}`, messages.slice(-1), attempt * 1000 + messages.length - 1, true) : undefined
              if (!reminder?.clicked) await step.do(attempt === 0 ? `waiting:${index}` : `waiting:${index}:r${attempt}`, async () => {
                await assertRunActive(env, runId)
                await moveRun(env.DB, run.id, 'waiting_click', { waitUntil: quicks.length ? Date.now() + quickWait : tokensExpireAt }).run()
              })
              try {
                const click = await step.waitForEvent<{ token: string }>(attempt === 0 ? `click:${index}` : `click:${index}:r${attempt}`, { type: `click_${index}`, timeout })
                clicked = click.payload
              } catch {
                // Workflows throws on waitForEvent timeout. Buttons use the optional timeout edge; quick replies resume at the next step.
                port = quicks.length ? 'next' : 'timeout'
              }
            }
            if (clicked) {
              const token = tokens.find(t => t.token === clicked.token)
              if (!token) throw new NonRetryableError('Invalid workflow click')
              const button = buttons.find(b => b.id === token.button_id)
              // Botão de retorno ao servidor (bloco dinâmico): a resposta dele vira o próximo passo.
              if (button?.action.type === 'dynamic') {
                await step.do(`clicked:${index}`, async () => { await assertRunActive(env, runId); await metric(env, run, node.id, 'clicked', token.button_id) })
                const virtual = `dynamic-callback:${index}`
                graph.nodes.push({ id: virtual, type: 'dynamic', position: { x: 0, y: 0 }, config: { url: button.action.url } })
                nodeId = virtual
                continue
              }
              // Botão "Ir para automação": roda as ações do botão, inicia a outra automação e encerra esta.
              if (button?.action.type === 'start_automation') {
                const target = button.action.automation_id
                if (button.actions?.length) await step.do(`button-actions:${index}`, async () => { await assertRunActive(env, runId); return actions(env, run, { actions: button.actions }, index) })
                await step.do(`clicked:${index}`, async () => { await assertRunActive(env, runId); await metric(env, run, node.id, 'clicked', token.button_id) })
                await step.do(`start:${index}`, async () => { await assertRunActive(env, runId); return startAutomation(env, run, index, { automation_id: target }) })
                nodeId = undefined
                continue
              }
              if (button?.actions?.length) await step.do(`button-actions:${index}`, async () => {
                await assertRunActive(env, runId)
                return actions(env, run, { actions: button.actions }, index)
              })
              await step.do(`clicked:${index}`, async () => { await assertRunActive(env, runId); await metric(env, run, node.id, 'clicked', token.button_id) })
              port = `btn:${token.button_id}`
              // Pular continues at the next step when its own exit is not connected.
              nodeId = next(node.id, port, token.button_id, ...(quicks.find(q => q.id === token.button_id)?.skip ? ['next'] : []))
              continue
            }
          }
        } else if (node.type === 'question') {
          port = await executeQuestion(env, step, run, index, node.id, node.config, adapter, caps)
          stepsSincePause = 0
        } else if (node.type === 'smart_delay') {
          const until = await step.do(`waiting:${index}`, async () => {
            const deadline = await delayDeadline(env.DB, run, node.config)
            await assertRunActive(env, runId)
            await moveRun(env.DB, run.id, 'waiting_delay', { waitReason: 'delay', waitUntil: deadline }).run()
            await notifyTimeline(env, run.workspace_id)
            return deadline
          })
          await step.sleep(`delay:${index}`, typeof until === 'number' ? Math.max(1, until - Date.now()) : milliseconds(node.config.duration))
          stepsSincePause = 0
          // Ponto de retomada: depois da espera, os próximos passos seguem a versão publicada agora, se ela ainda tem esta espera.
          const resumed = await step.do(`resume:${index}`, async () => {
            const current = await env.DB.prepare(`SELECT v.id,v.graph FROM automations a JOIN automation_versions v ON v.workspace_id=a.workspace_id AND v.id=a.published_version_id
              WHERE a.workspace_id=? AND a.id=? AND a.deleted_at IS NULL`).bind(run.workspace_id, run.automation_id).first<{ id: string; graph: string }>()
            if (!current || current.id === run.automation_version_id) return null
            const next = validateGraph(JSON.parse(current.graph))
            if (!next.nodes.some(n => n.id === node.id && n.type === 'smart_delay')) return null
            await env.DB.prepare('UPDATE flow_runs SET automation_version_id=? WHERE workspace_id=? AND id=?').bind(current.id, run.workspace_id, run.id).run()
            return { id: current.id, graph: current.graph }
          })
          if (resumed) {
            const next = validateGraph(JSON.parse(resumed.graph))
            graph.nodes.splice(0, graph.nodes.length, ...next.nodes)
            graph.edges.splice(0, graph.edges.length, ...next.edges)
            run.automation_version_id = resumed.id
          }
        } else if (['action','action_group'].includes(node.type)) {
          const result = await step.do(`action:${index}`, async () => { await assertRunActive(env, runId); return actions(env, run, node.config, index) })
          if (result?.deleted) return { runId, status: 'cancelled' }
        } else if (node.type === 'condition') {
          port = await step.do(`condition:${index}`, async () => { await assertRunActive(env, runId); return condition(env, run, node.config) })
        } else if (['randomizer','split'].includes(node.type)) {
          port = await step.do(`random:${index}`, async () => { await assertRunActive(env, runId); return randomize(env, run, node.id, node.config) })
        } else if (['start_automation','goto'].includes(node.type)) {
          const waits = waitsForCall(node)
          const childId = await step.do(`start:${index}`, async () => { await assertRunActive(env, runId); return startAutomation(env, run, index, node.config, waits) })
          // Esperar terminar: a chamada pode aguardar o contato por dias; o aviso do filho acorda, a conferência periódica é só a rede de segurança.
          if (waits) for (let poll = 0; ; poll++) {
            const state = await step.do(`call-state:${index}:${poll}`, async () => { await assertRunActive(env, runId); return callState(env, runId, childId) })
            // A chamada cancelada (contato saiu, automação foi para a lixeira) ou pausada pela segurança não conta como concluída:
            // esta execução acaba do mesmo jeito (cancelada) ou pausa no mesmo ponto, sem seguir para o passo seguinte. Chamada que falha segue (a outra falhar não derruba esta).
            if (state === 'cancelled') {
              await step.do(`call-cancelled:${index}`, async () => {
                await moveRun(env.DB, runId, 'cancelled', { error: null }).run()
                await notifyTimeline(env, run.workspace_id)
                await notifyParent(env, runId)
              })
              return { runId, status: 'cancelled' }
            }
            if (state === 'paused') {
              await step.do(`call-paused:${index}`, async () => {
                await assertRunActive(env, runId)
                await moveRun(env.DB, runId, 'waiting_delay', { waitReason: 'safety_pause', currentNodeId: node.id, error: 'consecutive_block_limit' }).run()
                await notifyTimeline(env, run.workspace_id)
                await notifyParent(env, runId)
              })
              return { runId, status: 'paused', reason: 'consecutive_block_limit' }
            }
            if (['done', 'failed'].includes(state)) break
            try { await step.waitForEvent(`call-done:${index}:${poll}`, { type: 'child_done', timeout: '12 hours' }) } catch { /* conferir de novo */ }
          }
          stepsSincePause = 0
        } else if (!['trigger','starting_step','note','comment'].includes(node.type)) {
          throw new NonRetryableError('Node type is not supported by flow executor')
        }
        nodeId = next(node.id, port, ...(port === 'next' ? ['then'] : []))
      }
      await step.do('finish', async () => {
        await assertRunActive(env, runId)
        await moveRun(env.DB, runId, 'done').run()
        await notifyParent(env, runId)
      })
      return { runId, status: 'done', degraded }
    } catch (error) {
      // Keep recovery I/O inside a step too: replay must never read mutable D1 state outside the durable boundary.
      const cancelled = await step.do('failed', async () => {
        const state = await env.DB.prepare('SELECT status FROM flow_runs WHERE id=?').bind(runId).first<{ status: string }>()
        if (state?.status === 'cancelled') { await notifyParent(env, runId); return true }
        if (channelFailureCode(error) === 'channel_outside_window') {
          const row = await env.DB.prepare('SELECT workspace_id,contact_id,channel_id FROM flow_runs WHERE id=?').bind(runId).first<{ workspace_id: string; contact_id: string; channel_id: string }>()
          if (row) {
            const connection = await env.DB.prepare('SELECT type FROM channels WHERE workspace_id=? AND id=?').bind(row.workspace_id, row.channel_id).first<{ type: ChannelType }>()
            const profile = connection ? (await storedConnection(env, connection.type, row.workspace_id, row.channel_id)).profile : undefined
            const hours = profile?.window?.standardHours
            const windowLabel = hours ? `a janela de ${hours} horas da conexão encerrou` : 'a janela de envio da conexão encerrou'
            await recordMessage(env, { id: `window-blocked:${runId}`, workspaceId: row.workspace_id,
              conversationId: await ensureConversation(env, row.workspace_id, row.contact_id, row.channel_id), direction: 'out', sender: 'system',
              text: `Envio barrado: ${windowLabel}. Aguarde uma nova mensagem do contato${profile?.templates ? ' ou use um modelo aprovado' : ''}.`, status: 'failed', error: 'channel_outside_window' })
          }
        }
        // Fixed error code only. Provider URLs, bot token, payload and SQL never enter logs/report.
        await moveRun(env.DB, runId, 'failed', { error: channelFailureCode(error) }).run()
        await notifyParent(env, runId)
        return false
      })
      if (cancelled) return { runId, status: 'cancelled' }
      throw error
    }
  }
}

// Errors thrown inside step.do cross a serialization boundary and lose their class; read the reason from the message.
function channelFailureCode(error: unknown): string {
  if (error instanceof Error && error.message.includes('Sequence enrollment cancelled')) return 'sequence_unsubscribed'
  if (error instanceof Error && error.message.includes('Automation child run limit')) return 'automation_child_limit'
  if (error instanceof Error && error.message.includes('Template step unsupported on channel')) return 'template_channel_unsupported'
  const reason = error instanceof Error ? /Channel send failed: ([a-z_]+)/.exec(error.message)?.[1] : undefined
  return reason ? `channel_${reason}` : 'flow_execution_failed'
}

class ChannelSendFailure extends NonRetryableError {
  constructor(readonly result: Extract<SendResult, { ok: false }>) {
    super(`Channel send failed: ${result.reason}${'detail' in result ? `: ${result.detail}` : ''}`)
  }
}
