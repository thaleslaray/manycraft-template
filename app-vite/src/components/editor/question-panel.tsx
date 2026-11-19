import { QuestionAnswers } from "./question-answers"
import { useRef } from "react"
import { CircleHelp } from "lucide-react"
import { questionFieldType, questionCapabilityError, questionSystemFields, questionSystemFieldFits } from "../../../../engine/src/schemas/question"
import { Button } from "@/components/ui/button"
import { Input, Textarea, field } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SidePanel } from "@/components/ui/side-panel"
import { NodeErrors, NodeLinks, type PanelProps } from "./panel-shared"
import { CatalogNotice } from "./logic-panels"
import { defaultConfig, questionConnections, questionRetryMessage, unitLabel, type Duration } from "./graph"
import { VariablePicker } from "./variable-picker"

const answerTypes = { text: "Texto", email: "E-mail", phone: "Telefone", number: "Número", multiple_choice: "Múltipla escolha", date: "Data", datetime: "Data e hora", url: "URL", image: "Imagem", file: "Arquivo", location: "Localização" }
const mediaTypes = ["image", "file", "location"]

/** Coleta: mensagem, validação e destino juntos, com caminhos explícitos abaixo. */
export function QuestionPanel(p: PanelProps) {
  const config = { ...defaultConfig("question"), ...p.node.data.config }
  const type = String(config.answer_type)
  const timeout = config.timeout as Duration
  const choices = Array.isArray(config.choices) ? config.choices as string[] : []
  const off = p.readOnly
  const textRef = useRef<HTMLTextAreaElement>(null)
  const targets = questionConnections(p.triggers, p.connections ?? [])
  const canChoose = targets.length > 0 && targets.every(c => !questionCapabilityError({ answer_type: "multiple_choice", choices: ["A", "B"], skip: Boolean(config.skip) }, c.profile ?? {}))
  const canReceiveMedia = targets.length > 0 && targets.every(c => !questionCapabilityError({ answer_type: "image", choices: [], skip: false }, c.profile ?? {}))
  const fields = (p.fields ?? []).filter(f => f.scope === "contact" && f.type === questionFieldType(type) && !("archived" in f && f.archived))
  const systemFields = Object.entries(questionSystemFields).filter(([id]) => questionSystemFieldFits(id, type))
  const selectClass = `${field} h-10 min-w-0`
  const variableProps = { fields: p.fields, botFields: p.botFields, loading: p.catalogLoading, error: p.catalogErrors?.fields, onRetry: p.reloadCatalogs }
  return <SidePanel title="Pergunta" tone="message" onClose={p.onClose}>
    <NodeErrors errors={p.errors} show={p.showErrors} />
    <div className="flex gap-2 rounded-md bg-surface-muted p-3 text-sm text-text-muted"><CircleHelp className="size-5 shrink-0" aria-hidden="true" /><p>Aguarde uma resposta e salve o dado no perfil do contato.</p></div>
    <div className="space-y-1"><Label htmlFor="question-text">Texto da pergunta</Label>
      <Textarea id="question-text" ref={textRef} value={String(config.text)} maxLength={4096} disabled={off} placeholder="Qual é seu e-mail?" onChange={e => p.updateConfig({ text: e.target.value })} />
      <VariablePicker {...variableProps} targetRef={textRef} value={String(config.text)} onChange={text => p.updateConfig({ text })} disabled={off} />
    </div>
    <div className="space-y-1"><Label htmlFor="question-type">Tipo de resposta</Label>
      <select id="question-type" className={selectClass} value={type} disabled={off} onChange={e => {
        const answer_type = e.target.value
        const current = p.fields?.find(f => f.id === config.field_id)
        const keeps = String(config.field_id).startsWith("system:") ? questionSystemFieldFits(String(config.field_id), answer_type) : current?.type === questionFieldType(answer_type)
        p.updateConfig({ answer_type, ...(keeps ? {} : { field_id: "" }), retry_message: questionRetryMessage(answer_type, config.retry_message) })
      }}>{Object.entries(answerTypes).map(([id, label]) => <option key={id} value={id} disabled={id === "multiple_choice" ? !canChoose : mediaTypes.includes(id) && !canReceiveMedia}>{label}</option>)}</select>
      {!canChoose ? <p className="text-xs text-text-muted">Múltipla escolha precisa de botões, lista ou respostas rápidas nas conexões do gatilho.</p> : null}
      {!canReceiveMedia ? <p className="text-xs text-text-muted">Imagem, arquivo e localização precisam de conexões que recebem fotos e arquivos.</p> : null}
      {p.catalogErrors?.connections ? <p role="alert" className="text-xs text-danger">Não foi possível consultar as fichas das conexões. <Button variant="ghost" size="sm" onClick={p.reloadCatalogs}>Tentar de novo</Button></p> : null}
    </div>
    {type === "datetime" ? <p className="text-xs text-text-muted">Aceita 24/10/2026 14:30, 24/10/2026 14h30 ou 2026-10-24 14:30. Sem fuso na resposta, vale o fuso do contato (ou o da conta). Salve em um campo do tipo Data e hora.</p> : null}
    {type === "multiple_choice" ? <div className="space-y-1"><Label htmlFor="question-choices">Opções de resposta</Label><Textarea id="question-choices" disabled={off} value={choices.join("\n")} onChange={e => p.updateConfig({ choices: e.target.value.split("\n") })} /><p className="text-xs text-text-muted">Uma opção por linha. Use de 2 a 10 opções, dentro do limite da conexão.</p></div> : null}
    <CatalogNotice p={p} kind="fields" />
    <div className="space-y-1"><Label htmlFor="question-field">Salvar resposta no campo</Label>
      <select id="question-field" className={selectClass} disabled={off || p.catalogLoading} value={String(config.field_id)} onChange={e => p.updateConfig({ field_id: e.target.value })}>
        <option value="">Escolha um campo</option>
        {systemFields.length ? <optgroup label="Campos do sistema">{systemFields.map(([id, f]) => <option key={id} value={id}>{f.label}</option>)}</optgroup> : null}
        {config.field_id && !fields.some(f => f.id === config.field_id) && !systemFields.some(([id]) => id === config.field_id) ? <option value={String(config.field_id)}>Campo indisponível ou incompatível</option> : null}
        {fields.length ? <optgroup label="Campos personalizados">{fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</optgroup> : null}
      </select>
      {!fields.length && !systemFields.length && !p.catalogLoading ? <p className="text-xs text-text-muted">Crie um campo compatível em Configurações → Campos.</p> : null}
    </div>
    <fieldset className="space-y-3 rounded-lg border border-border p-3"><legend className="px-1 text-xs font-semibold text-text-muted">Se a resposta for inválida</legend>
      <div className="space-y-1"><Label htmlFor="question-retry">Mensagem de nova tentativa</Label><Textarea id="question-retry" disabled={off} value={String(config.retry_message)} maxLength={4096} onChange={e => p.updateConfig({ retry_message: e.target.value })} /></div>
      <div className="space-y-1"><Label htmlFor="question-attempts">Limite de tentativas</Label><Input id="question-attempts" type="number" min={1} max={10} disabled={off} value={Number(config.max_attempts)} onChange={e => p.updateConfig({ max_attempts: Number(e.target.value) })} /></div>
    </fieldset>
    <fieldset className="space-y-3 rounded-lg border border-border p-3"><legend className="px-1 text-xs font-semibold text-text-muted">Se o contato não responder</legend>
      <div className="grid grid-cols-2 gap-2"><div className="space-y-1"><Label htmlFor="question-timeout">Tempo limite</Label><Input id="question-timeout" type="number" min={1} disabled={off} value={timeout.value} onChange={e => p.updateConfig({ timeout: { ...timeout, value: Number(e.target.value) } })} /></div>
        <div className="space-y-1"><Label htmlFor="question-unit">Unidade do tempo limite</Label><select id="question-unit" className={selectClass} disabled={off} value={timeout.unit} onChange={e => p.updateConfig({ timeout: { ...timeout, unit: e.target.value } })}>{Object.entries(unitLabel).map(([unit, label]) => <option key={unit} value={unit}>{label}</option>)}</select></div></div>
{config.field_id === "system:email" || config.field_id === "system:phone" ? (() => {
        const options = config.field_id === "system:email" ? [["email", "E-mail"]] : [["whatsapp", "WhatsApp"]]
        const chosen = (Array.isArray(config.opt_in) ? config.opt_in : []).filter(c => options.some(([id]) => id === c)) as string[]
        return <fieldset className="space-y-2 rounded-md border border-border p-3">
          <legend className="px-1 text-xs font-semibold text-text-muted">Opt-in junto da coleta</legend>
          {options.map(([id, label]) => <label key={id} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={off} checked={chosen.includes(id)} onChange={e => p.updateConfig({ opt_in: e.target.checked ? [...chosen, id] : chosen.filter(c => c !== id) })} />Autorizar mensagens por {label}</label>)}
          {chosen.length ? <div className="space-y-1"><label htmlFor="question-consent" className="text-xs font-semibold">Frase de consentimento que o contato vê</label><textarea id="question-consent" rows={2} maxLength={500} disabled={off} className="w-full rounded-md border border-border-input bg-surface px-2 py-1 text-sm" value={String(config.consent_phrase ?? "")} onChange={e => p.updateConfig({ consent_phrase: e.target.value })} placeholder="Ao responder, você aceita receber nossas mensagens. Para sair, envie SAIR." /></div> : null}
        </fieldset>
      })() : null}
      <QuestionAnswers automationId={p.automationId} nodeId={p.node.id} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(config.skip)} disabled={off} onChange={e => p.updateConfig({ skip: e.target.checked })} />Permitir pular</label>
      <p className="text-xs text-text-muted">Pular, esgotar tentativas ou atingir o tempo limite leva ao caminho “Sem resposta”. “Parar” encerra a coleta e cancela a inscrição.</p>
    </fieldset>
    <NodeLinks p={p} />
  </SidePanel>
}
