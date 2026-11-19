import { useEffect, useState } from 'react'
import { CheckCircle2, FileUp, LoaderCircle } from 'lucide-react'
import { listTags, type Tag } from '@/data'
import { getContactImport, listImportFields, parseContactCsv, retryContactImport, startContactImport, type ContactImport, type ImportField } from '@/data/contact-imports'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const systemFields = [['first_name', 'Primeiro nome'], ['last_name', 'Sobrenome'], ['email', 'E-mail'], ['phone', 'Telefone']]
const steps = ['Arquivo', 'Colunas', 'Revisão', 'Resultado']
const fieldTypes: Record<string, string> = { text: 'texto', number: 'número', date: 'data', datetime: 'data e hora', boolean: 'sim/não', array: 'lista' }
type FileData = { name: string; csv: string; headers: string[]; rows: string[][] }

export function ImportContactsDialog({ workspace, jobId, onStarted, onClose }: {
  workspace: string; jobId: string | null; onStarted: (id: string) => void; onClose: () => void
}) {
  const [step, setStep] = useState(0), [file, setFile] = useState<FileData | null>(null)
  const [consent, setConsent] = useState(false), [mapping, setMapping] = useState<string[]>([]), [selectedTags, setSelectedTags] = useState<string[]>([])
  const [fields, setFields] = useState<ImportField[]>([]), [tags, setTags] = useState<Tag[]>([])
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [report, setReport] = useState<ContactImport | null>(null), [poll, setPoll] = useState(0)
  const current = jobId ? 3 : step
  useEffect(() => {
    let active = true
    Promise.all([listImportFields(), listTags(workspace)]).then(([fields, tags]) => {
      if (active) { setFields(fields.filter(field => field.scope === 'contact' && !field.archived)); setTags(tags.filter(tag => !(tag as Tag & { archived?: boolean }).archived)); setReady(true) }
    }).catch(() => { if (active) setError('Não foi possível carregar os campos e as tags. Feche e tente novamente.') })
    return () => { active = false }
  }, [workspace])
  useEffect(() => {
    if (!jobId) return
    let active = true, timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const next = await getContactImport(jobId!)
        if (!active) return
        setReport(next); setError('')
        if (!['completed', 'failed'].includes(next.status)) timer = setTimeout(refresh, 1000)
      } catch { if (active) setError('Não foi possível atualizar o progresso. Tente consultar novamente.') }
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [jobId, poll])

  const targets = mapping.filter(Boolean)
  const validMapping = (targets.includes('email') || targets.includes('phone')) && new Set(targets).size === targets.length
  const percent = report ? Math.round(report.processed / report.total * 100) : 0
  const completed = report?.status === 'completed'
  const title = current < 3 ? 'Importar contatos' : completed ? 'Importação concluída' : report?.status === 'failed' ? 'Importação interrompida' : 'Importando contatos'

  async function start() {
    if (!file || !consent || !validMapping) return
    setBusy(true); setError('')
    try {
      const job = await startContactImport({ file_name: file.name, csv: file.csv, consent: true,
        mapping: Object.fromEntries(mapping.flatMap((target, column) => target ? [[target, column]] : [])), tag_ids: selectedTags })
      setReport(job); onStarted(job.id)
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível iniciar a importação.') }
    finally { setBusy(false) }
  }

  return <Dialog open onOpenChange={open => !open && !busy && onClose()}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-3xl overflow-y-auto">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>Organize os dados, confira as colunas e acompanhe o resultado do seu lote.</DialogDescription></DialogHeader>
      <ol aria-label="Etapas da importação" className="grid grid-cols-4 border-b border-border pb-4 text-center text-xs sm:text-sm">
        {steps.map((label, index) => <li key={label} aria-current={index === current ? 'step' : undefined} className={index === current ? 'font-semibold text-text' : 'text-text-muted'}><span className="mb-1 block">{index + 1}</span>{label}</li>)}
      </ol>
      {current === 0 && <div className="space-y-5">
        <div className="space-y-3 rounded-lg border border-dashed border-border-input p-5">
          <FileUp className="size-8 text-text-muted" aria-hidden="true" />
          <Label htmlFor="import-file">Arquivo CSV</Label>
          <Input id="import-file" type="file" accept=".csv,text/csv" className="h-auto py-2" onChange={async event => {
            const selected = event.target.files?.[0]
            setFile(null); setError('')
            if (!selected) return
            if (selected.size > 1024 * 1024) { setError('Escolha um CSV de até 1 MB.'); return }
            try {
              const csv = await selected.text(), parsed = parseContactCsv(csv)
              setFile({ name: selected.name, csv, ...parsed })
              setMapping(parsed.headers.map(header => {
                const key = header.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[\s_-]/g, '')
                return ({ nome: 'first_name', primeironome: 'first_name', firstname: 'first_name', sobrenome: 'last_name', lastname: 'last_name', email: 'email', telefone: 'phone', phone: 'phone' } as Record<string, string>)[key] ?? ''
              }))
            } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível ler o CSV.') }
          }} />
          <p className="text-xs text-text-muted">Até 1 MB e 20.000 linhas. Use a primeira linha para os títulos das colunas. Separador: vírgula ou ponto e vírgula.</p>
          {file && <p role="status" className="text-sm">{file.name} · {file.rows.length} linhas · {file.headers.length} colunas</p>}
        </div>
        <label className="flex items-start gap-3 text-sm"><Checkbox checked={consent} onCheckedChange={checked => setConsent(checked === true)} /><span>Tenho consentimento das pessoas deste arquivo para cadastrar e tratar seus dados.</span></label>
        <p className="text-xs text-text-muted">A importação não altera o consentimento de envio de nenhuma conexão.</p>
      </div>}
      {current === 1 && file && <div className="space-y-4">
        <p className="text-sm text-text-muted">Escolha o destino de cada coluna. Mapeie pelo menos e-mail ou telefone para identificar os contatos.</p>
        <div className="divide-y divide-border rounded-md border border-border">
          {file.headers.map((header, column) => <div key={column} className="grid min-w-0 gap-2 p-3 sm:grid-cols-2 sm:items-center">
            <div className="min-w-0"><Label htmlFor={`import-column-${column}`}>Campo para {header}</Label><p className="truncate text-xs text-text-muted" title={file.rows[0][column]}>Exemplo: {file.rows[0][column] || 'vazio'}</p></div>
            <select id={`import-column-${column}`} value={mapping[column] ?? ''} onChange={event => setMapping(values => values.map((value, i) => i === column ? event.target.value : value))} className="h-10 w-full min-w-0 rounded-md border border-border-input bg-surface px-2 text-sm">
              <option value="">Ignorar coluna</option>
              <optgroup label="Campos do sistema">{systemFields.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</optgroup>
              {fields.length > 0 && <optgroup label="Campos personalizados">{fields.map(field => <option key={field.id} value={`field:${field.id}`}>{field.name} ({fieldTypes[field.type] ?? field.type})</option>)}</optgroup>}
            </select>
          </div>)}
        </div>
        {!validMapping && <p role="status" className="text-sm text-text-muted">Mapeie e-mail ou telefone e use cada campo apenas uma vez.</p>}
      </div>}
      {current === 2 && file && <div className="space-y-5">
        <div className="rounded-lg border border-border p-4 text-sm"><p className="font-semibold break-all">{file.name}</p><p className="mt-2">{file.rows.length} linhas · {targets.length} colunas mapeadas</p><p className="mt-2 text-text-muted">Contatos com o mesmo e-mail ou telefone serão atualizados. Dados inválidos serão ignorados e aparecerão no relatório.</p></div>
        <fieldset className="space-y-3"><legend className="mb-2 text-sm font-semibold">Tags opcionais</legend>
          {tags.length ? <div className="grid max-h-40 gap-3 overflow-y-auto sm:grid-cols-2">{tags.map(tag => <label key={tag.id} className="flex min-w-0 items-center gap-2 text-sm"><Checkbox checked={selectedTags.includes(tag.id)} onCheckedChange={checked => setSelectedTags(values => checked ? [...values, tag.id] : values.filter(id => id !== tag.id))} disabled={!selectedTags.includes(tag.id) && selectedTags.length >= 20} /><span className="break-all">{tag.name}</span></label>)}</div> : <p className="text-sm text-text-muted">Nenhuma tag disponível. Você pode importar sem tags.</p>}
        </fieldset>
        <p className="text-xs text-text-muted">Consentimento confirmado. Novos contatos entram na lista; as permissões de envio das conexões são preservadas.</p>
      </div>}
      {current === 3 && <div className="space-y-5" aria-live="polite">
        <div className="flex items-center gap-3">{completed ? <CheckCircle2 className="size-7 text-text" aria-hidden="true" /> : <LoaderCircle className="size-7 animate-spin text-text-muted" aria-hidden="true" />}<p className="min-w-0 break-all text-sm">{report?.file_name ?? 'Consultando importação…'}</p></div>
        <div role="progressbar" aria-label="Progresso da importação" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 overflow-hidden rounded-full bg-border"><div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} /></div>
        <p className="text-sm">{report?.processed ?? 0} de {report?.total ?? 0} linhas processadas ({percent}%)</p>
        {report && <div className="grid grid-cols-3 gap-2 text-center text-sm">{[[report.created, 'criado'], [report.updated, 'atualizado'], [report.ignored, 'ignorado']].map(([count, label]) => <div key={label} className="rounded-md border border-border p-3">{count} {label}{count === 1 ? '' : 's'}</div>)}</div>}
        {report?.ignored_rows.length ? <div className="space-y-2"><h3 className="text-sm font-semibold">Linhas ignoradas{report.ignored > 100 ? ' (primeiras 100)' : ''}</h3><ul className="max-h-40 space-y-2 overflow-y-auto text-sm text-text-muted">{report.ignored_rows.map(row => <li key={row.line}>Linha {row.line}: {row.reason}</li>)}</ul></div> : null}
        {report?.status === 'failed' ? <div className="space-y-2"><p role="alert" className="text-sm text-danger">{report.error}</p><Button variant="secondary" loading={busy} onClick={async () => {
          if (!jobId) return
          setBusy(true)
          try { setReport(await retryContactImport(jobId)); setPoll(value => value + 1) } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível retomar.') }
          finally { setBusy(false) }
        }}>Retomar importação</Button></div> : !completed && <p className="text-xs text-text-muted">Você pode recarregar esta página. O processamento continua no motor.</p>}
      </div>}
      {error && <div role="alert" className="text-sm text-danger">{error}{jobId && <Button variant="ghost" onClick={() => setPoll(value => value + 1)}>Consultar novamente</Button>}</div>}
      <DialogFooter className="flex-wrap">
        {current < 3 ? <><Button variant="secondary" disabled={busy} onClick={() => current === 0 ? onClose() : setStep(value => value - 1)}>{current === 0 ? 'Cancelar' : 'Voltar'}</Button>
          {current === 0 && <Button disabled={!file || !consent || !ready} onClick={() => setStep(1)}>Mapear colunas</Button>}
          {current === 1 && <Button disabled={!validMapping} onClick={() => setStep(2)}>Revisar importação</Button>}
          {current === 2 && <Button loading={busy} onClick={start}>Iniciar importação</Button>}</>
          : <Button onClick={onClose}>{completed ? 'Concluir' : 'Fechar'}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
