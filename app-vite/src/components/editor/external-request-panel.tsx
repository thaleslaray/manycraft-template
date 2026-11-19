import * as React from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAsync } from "@/hooks/use-async"
import { listExternalLogs, searchExternalContacts, testExternalRequest, type ExternalTestResult } from "@/data/external-requests"
import { Choice } from "./logic-panels"
import { VariablePicker } from "./variable-picker"
import { externalMethods, type ExternalRequestAction } from "./graph"
import type { PanelProps } from "./panel-shared"

const MAX_HEADERS = 10
const MAX_MAPPINGS = 10
const when = (time: number) => new Date(time).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })

/** Configuração da requisição externa: o motor chama o endereço com os dados do contato e grava só uma resposta 200. */
export function ExternalRequestFields({ index, action, p, change }: { index: number; action: ExternalRequestAction; p: PanelProps; change: (next: ExternalRequestAction) => void }) {
  const off = p.readOnly
  const urlRef = React.useRef<HTMLInputElement>(null)
  const bodyRef = React.useRef<HTMLTextAreaElement>(null)
  const variableProps = { fields: p.fields, botFields: p.botFields, loading: p.catalogLoading, error: p.catalogErrors?.fields, onRetry: p.reloadCatalogs }
  const headers = action.headers ?? [], mappings = action.mappings ?? []
  const contactFields = (p.fields ?? []).filter(f => f.scope === "contact").map(f => ({ id: f.id, name: f.name }))
  const withBody = action.method !== "GET"
  return <div className="space-y-3">
    <Choice id={`req-method-${index}`} label="Método" value={action.method} disabled={off} options={externalMethods.map(id => ({ id, name: id }))} onChange={method => change({ ...action, method: method as ExternalRequestAction["method"] })} />
    <div className="space-y-1"><Label htmlFor={`req-url-${index}`}>Endereço</Label>
      <Input id={`req-url-${index}`} ref={urlRef} value={action.url ?? ""} maxLength={2048} disabled={off} placeholder="https://api.seusite.com/clientes" onChange={e => change({ ...action, url: e.target.value })} />
      <VariablePicker {...variableProps} targetRef={urlRef} value={action.url ?? ""} onChange={url => change({ ...action, url })} disabled={off} />
      <p className="text-xs text-text-muted">Variáveis só valem depois do domínio. Endereços de rede interna são bloqueados.</p>
    </div>
    <fieldset className="space-y-2"><legend className="text-sm font-semibold">Cabeçalhos</legend>
      {headers.map((header, i) => <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
        <div className="min-w-0 space-y-1"><Label htmlFor={`req-hname-${index}-${i}`}>Nome do cabeçalho {i + 1}</Label><Input id={`req-hname-${index}-${i}`} value={header.name} maxLength={100} disabled={off} placeholder="Authorization" onChange={e => change({ ...action, headers: headers.map((h, j) => j === i ? { ...h, name: e.target.value } : h) })} /></div>
        <div className="min-w-0 space-y-1"><Label htmlFor={`req-hvalue-${index}-${i}`}>Valor do cabeçalho {i + 1}</Label><Input id={`req-hvalue-${index}-${i}`} value={header.value} maxLength={2000} disabled={off} onChange={e => change({ ...action, headers: headers.map((h, j) => j === i ? { ...h, value: e.target.value } : h) })} /></div>
        <Button variant="ghost" size="icon" aria-label={`Remover cabeçalho ${i + 1}`} disabled={off} onClick={() => change({ ...action, headers: headers.filter((_, j) => j !== i) })}><Trash2 className="size-4" aria-hidden="true" /></Button>
      </div>)}
      <Button variant="secondary" size="sm" disabled={off || headers.length >= MAX_HEADERS} onClick={() => change({ ...action, headers: [...headers, { name: "", value: "" }] })}><Plus className="size-4" aria-hidden="true" />Adicionar cabeçalho</Button>
    </fieldset>
    {withBody ? <div className="space-y-1"><Label htmlFor={`req-body-${index}`}>Corpo da requisição</Label>
      <Textarea id={`req-body-${index}`} ref={bodyRef} value={action.body ?? ""} maxLength={10000} disabled={off} placeholder='{"email": "{{campo:...|}}"}' onChange={e => change({ ...action, body: e.target.value })} />
      <VariablePicker {...variableProps} targetRef={bodyRef} value={action.body ?? ""} onChange={body => change({ ...action, body })} disabled={off} />
      <p className="text-xs text-text-muted">Use {"{{full_contact_data}}"} para enviar todos os dados do contato em JSON.</p>
      <p className="text-xs text-text-muted">Sem cabeçalho de tipo, o corpo segue como JSON.</p>
    </div> : null}
    <fieldset className="space-y-2"><legend className="text-sm font-semibold">Guardar a resposta em campos</legend>
      <p className="text-xs text-text-muted">Só uma resposta 200 grava. Use o caminho do JSON, como data.plano ou itens[0].nome.</p>
      {mappings.map((mapping, i) => <div key={i} className="space-y-2 rounded-md border border-border p-2">
        <div className="space-y-1"><Label htmlFor={`req-path-${index}-${i}`}>Caminho no JSON {i + 1}</Label><Input id={`req-path-${index}-${i}`} value={mapping.path} maxLength={200} disabled={off} placeholder="data.plano" onChange={e => change({ ...action, mappings: mappings.map((m, j) => j === i ? { ...m, path: e.target.value } : m) })} /></div>
        <Choice id={`req-mapfield-${index}-${i}`} label={`Campo de destino ${i + 1}`} value={mapping.field_id} disabled={off || p.catalogLoading} options={contactFields} onChange={field_id => change({ ...action, mappings: mappings.map((m, j) => j === i ? { ...m, field_id } : m) })} />
        <Button variant="ghost" size="sm" disabled={off} onClick={() => change({ ...action, mappings: mappings.filter((_, j) => j !== i) })}><Trash2 className="size-4" aria-hidden="true" />Remover mapeamento {i + 1}</Button>
      </div>)}
      <Button variant="secondary" size="sm" disabled={off || mappings.length >= MAX_MAPPINGS} onClick={() => change({ ...action, mappings: [...mappings, { path: "", field_id: "" }] })}><Plus className="size-4" aria-hidden="true" />Adicionar mapeamento</Button>
    </fieldset>
    <p className="text-xs text-text-muted">Tempo limite de 10 segundos. Se falhar, o fluxo continua e o erro aparece no registro abaixo.</p>
    <RequestTester action={action} p={p} index={index} />
  </div>
}

function RequestTester({ action, p, index }: { action: ExternalRequestAction; p: PanelProps; index: number }) {
  const [search, setSearch] = React.useState("")
  const [contactId, setContactId] = React.useState("")
  const [result, setResult] = React.useState<ExternalTestResult | null>(null)
  const [failure, setFailure] = React.useState<string | null>(null)
  const [running, setRunning] = React.useState(false)
  const contacts = useAsync(() => searchExternalContacts(search), `req-contacts-${search}`)
  const logs = useAsync(() => listExternalLogs(p.automationId), `req-logs-${p.automationId ?? "all"}`)
  const fieldName = (id: string) => p.fields?.find(f => f.id === id)?.name ?? "Campo indisponível"
  async function run() {
    setRunning(true); setFailure(null); setResult(null)
    try { setResult(await testExternalRequest(action, contactId, p.automationId)) }
    catch (error) { setFailure(error instanceof Error ? error.message : "Não foi possível testar.") }
    finally { setRunning(false); logs.reload?.() }
  }
  return <section aria-label="Testar requisição" className="space-y-3 rounded-lg bg-surface-muted p-3">
    <h4 className="text-sm font-semibold">Testar com um contato</h4>
    <div className="space-y-1"><Label htmlFor={`req-search-${index}`}>Buscar contato</Label><Input id={`req-search-${index}`} value={search} placeholder="Nome do contato" onChange={e => setSearch(e.target.value)} /></div>
    {contacts.loading && !contacts.stale ? <p role="status" className="text-xs text-text-muted">Buscando contatos...</p> : contacts.error ? <p role="alert" className="text-xs text-danger">Não foi possível listar os contatos.</p>
      : <Choice id={`req-contact-${index}`} label="Contato do teste" value={contactId} options={contacts.data ?? contacts.stale ?? []} onChange={setContactId} />}
    <Button variant="secondary" size="sm" loading={running} disabled={!contactId || running} onClick={run}>Testar requisição</Button>
    <p className="text-xs text-text-muted">O teste chama o endereço de verdade com os dados do contato, mas não grava nada nele.</p>
    {failure ? <p role="alert" className="rounded-md bg-warning-soft p-3 text-sm text-warning">{failure}</p> : null}
    {result ? <div role="status" aria-label="Resultado do teste" className="space-y-2 rounded-md border border-border bg-surface p-3 text-sm">
      <p className="font-semibold">{result.ok ? "Requisição concluída" : `Falhou: ${result.error?.message ?? "erro desconhecido"}`}</p>
      <p className="text-xs text-text-muted">{result.status ? `Resposta ${result.status}` : "Sem resposta"} em {result.duration_ms} ms</p>
      {result.mapped.length ? <ul className="space-y-1">{result.mapped.map(item => <li key={item.field_id} className="break-words">
        {item.ok ? <>{item.path} gravaria <strong>{String(item.value)}</strong> em {fieldName(item.field_id)}</> : <>{item.path}: {item.error}</>}</li>)}</ul> : null}
      {result.preview ? <pre aria-label="Prévia da resposta" className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-bg p-2 text-xs">{result.preview}</pre> : null}
    </div> : null}
    <div role="region" aria-label="Registro de erros da requisição" className="space-y-2">
      <div className="flex items-center justify-between gap-2"><h4 className="text-sm font-semibold">Registro de erros</h4><Button variant="ghost" size="sm" onClick={() => logs.reload?.()}>Atualizar registro</Button></div>
      {logs.loading ? <p role="status" className="text-xs text-text-muted">Carregando registro...</p> : logs.error ? <p role="alert" className="text-xs text-danger">Não foi possível carregar o registro.</p>
        : !logs.data?.length ? <p className="text-xs text-text-muted">Nenhum erro registrado.</p>
        : <ul className="space-y-2">{logs.data.map(log => <li key={log.id} className="space-y-0.5 rounded-md border border-border bg-surface p-2 text-xs">
          <p className="font-semibold">{log.outcome === "error" ? "Erro" : "Teste ok"}{log.source === "test" ? " (teste)" : ""}: {log.method} {log.target}</p>
          {log.message ? <p>{log.message}</p> : null}
          <p className="text-text-muted">{when(log.created_at)} · {log.status ? `HTTP ${log.status} · ` : ""}{log.duration_ms} ms{log.contact_name ? ` · ${log.contact_name}` : ""}</p>
        </li>)}</ul>}
    </div>
  </section>
}
