import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { Variable } from "lucide-react"
import { messageVariable, messageVariables } from "../../../../engine/src/schemas/message-variables"
import { Button } from "@/components/ui/button"
import { Input, field as inputClass } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"

type VariableField = { id: string; name: string; scope: string; archived?: boolean | number }
export type VariableCatalogProps = {
  fields?: VariableField[]
  botFields?: VariableField[]
  loading?: boolean
  error?: boolean
  onRetry?: () => void
}

/** Shares the engine's token syntax and preserves the selection while the picker has focus. */
export function VariablePicker({ fields = [], botFields = [], loading, error, onRetry, targetRef, value, onChange, disabled }: VariableCatalogProps & {
  targetRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState("primeiro_nome")
  const [fallback, setFallback] = useState("")
  const selection = useRef({ start: value.length, end: value.length })
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const caret = pendingCaret.current
    if (caret === null) return
    pendingCaret.current = null
    targetRef.current?.focus()
    targetRef.current?.setSelectionRange(caret, caret)
  }, [value, open, targetRef])
  const available = fields.filter(field => field.scope === "contact" && !field.archived)
  const bots = botFields.filter(field => !field.archived)
  const customAvailable = selected.startsWith("bot:") ? bots.some(field => `bot:${field.id}` === selected) : !selected.startsWith("campo:") || available.some(field => `campo:${field.id}` === selected)

  function toggle() {
    if (!open) {
      const target = targetRef.current
      selection.current = { start: target?.selectionStart ?? value.length, end: target?.selectionEnd ?? value.length }
    }
    setOpen(!open)
  }
  function insert() {
    // Sem texto de reserva o "|" vazio sai; o parser entende {{campo}}.
    const raw = messageVariable(selected, fallback)
    const token = fallback ? raw : raw.replace(/\|\}\}$/, "}}")
    const { start, end } = selection.current
    // Palavra colada na variável ganha um espaço entre elas.
    const before = start > 0 && !/\s/.test(value[start - 1]) ? " " : ""
    const after = end < value.length && !/\s/.test(value[end]) ? " " : ""
    pendingCaret.current = start + before.length + token.length
    onChange(value.slice(0, start) + before + token + after + value.slice(end))
    setOpen(false)
  }

  return <div className="min-w-0 space-y-2">
    <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={toggle} aria-expanded={open} aria-controls={`${id}-picker`}>
      <Variable className="size-4" aria-hidden="true" />Inserir variável
    </Button>
    {open ? <div id={`${id}-picker`} role="group" aria-label="Inserir variável" className="min-w-0 space-y-3 rounded-md border border-border bg-surface-muted p-3">
      <div className="space-y-1"><Label htmlFor={`${id}-field`}>Campo</Label>
        <select id={`${id}-field`} className={`${inputClass} h-10 w-full min-w-0`} value={selected} disabled={disabled} onChange={event => setSelected(event.target.value)}>
          <optgroup label="Dados do contato"><option value="primeiro_nome">Primeiro nome</option><option value="sobrenome">Sobrenome</option><option value="nome_completo">Nome completo</option><option value="email">E-mail</option><option value="telefone">Telefone</option><option value="genero">Gênero</option><option value="idioma">Idioma</option><option value="fuso">Fuso horário</option><option value="ultima_mensagem">Última mensagem recebida</option><option value="inscrito_em">Data de inscrição</option><option value="ultima_interacao">Última interação</option><option value="contato_id">ID do contato</option><option value="nome_da_pagina">Nome da página (espaço)</option><option value="ultimo_carrinho">Último carrinho (pedido)</option></optgroup><optgroup label="Instagram"><option value="canal_usuario">Usuário do Instagram</option><option value="canal_seguidores">Número de seguidores</option><option value="canal_segue_conta">Segue a sua conta (sim ou não)</option><option value="canal_verificado">Conta verificada (sim ou não)</option></optgroup>
          <optgroup label="Origem do anúncio"><option value="anuncio_titulo">Título do anúncio</option><option value="anuncio_id">ID do anúncio</option><option value="anuncio_clique">Código do clique (ctwa_clid)</option></optgroup>
          {!loading && !error && available.length ? <optgroup label="Campos personalizados">{available.map(field => <option key={field.id} value={`campo:${field.id}`}>{field.name}</option>)}</optgroup> : null}
          {bots.length ? <optgroup label="Campos do bot">{bots.map(field => <option key={field.id} value={`bot:${field.id}`}>{field.name}</option>)}</optgroup> : null}
        </select>
      </div>
      {loading ? <div role="status" aria-label="Carregando campos"><Skeleton className="h-4 w-2/3" /></div> : error ? <div role="alert" className="space-y-2 text-sm"><p>Não foi possível listar os campos de contato.</p><Button type="button" variant="secondary" size="sm" onClick={onRetry}>Tentar de novo</Button></div> : null}
      <div className="space-y-1"><Label htmlFor={`${id}-fallback`}>Texto de reserva</Label><Input id={`${id}-fallback`} value={fallback} maxLength={2000} disabled={disabled} placeholder="Usado quando o campo estiver vazio" onChange={event => setFallback(event.target.value)} /></div>
      <p className="text-xs text-text-muted">A reserva aparece quando o contato ainda não tem esse dado.</p>
      <Button type="button" variant="secondary" size="sm" disabled={disabled || !customAvailable || (selected.startsWith("campo:") && (loading || error))} onClick={insert}>Inserir no texto</Button>
    </div> : null}
  </div>
}

const systemLabels: Record<string, string> = { primeiro_nome: "Primeiro nome", sobrenome: "Sobrenome", nome_completo: "Nome completo", email: "E-mail", telefone: "Telefone",
  nome_da_pagina: "Nome da página", genero: "Gênero", idioma: "Idioma", fuso: "Fuso", ultima_mensagem: "Última mensagem", ultimo_carrinho: "Último carrinho",
  anuncio_titulo: "Título do anúncio", anuncio_id: "ID do anúncio", anuncio_clique: "Código do clique", canal_usuario: "Usuário no canal" }

/** Texto com as variáveis trocadas pelo nome do campo (“[Primeiro nome ou amigo]”), para o mapa; o que é gravado continua {{...}}. */
export function variableLabels(text: string, fields: VariableField[] = [], botFields: VariableField[] = []): string {
  let out = text
  for (const v of messageVariables(text)) {
    const name = v.field.startsWith("campo:") ? fields.find(f => `campo:${f.id}` === v.field)?.name
      : v.field.startsWith("bot:") ? botFields.find(f => `bot:${f.id}` === v.field)?.name
      : systemLabels[v.field]
    out = out.replace(v.raw, `[${name ?? "campo indisponível"}${v.fallback ? ` ou ${v.fallback}` : ""}]`)
  }
  return out
}
