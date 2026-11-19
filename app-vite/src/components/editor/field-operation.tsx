import * as React from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Choice, FieldValue } from "./logic-panels"
import { VariablePicker } from "./variable-picker"
import { fieldOperationLabels, fieldOperationsFor, initialFieldValue, type EditorField, type FieldAction, type FieldOperation } from "./graph"
import type { PanelProps } from "./panel-shared"

/** Operação e valor da ação Definir campo; as operações mudam conforme o tipo do campo. */
export function FieldOperationControls({ index, action, field, p, change }: {
  index: number; action: FieldAction; field?: EditorField; p: PanelProps; change: (next: FieldAction) => void
}) {
  const off = p.readOnly
  const ref = React.useRef<HTMLInputElement>(null)
  const operation: FieldOperation = action.operation ?? "set"
  const variableProps = { fields: p.fields, botFields: p.botFields, loading: p.catalogLoading, error: p.catalogErrors?.fields, onRetry: p.reloadCatalogs }
  const options = fieldOperationsFor(field).map(id => ({ id, name: fieldOperationLabels[id] }))
  function chooseOperation(next: string) {
    const op = next as FieldOperation
    const { operation: _operation, value: _value, ...rest } = action
    if (op === "set") change({ ...rest, value: initialFieldValue(field) })
    else if (op === "clear" || op === "set_now") change({ ...rest, operation: op })
    else change({ ...rest, operation: op, value: op === "add_days" ? 1 : 0 })
  }
  const textValue = typeof action.value === "string" ? action.value : action.value == null ? "" : String(action.value)
  const operand = (op: FieldOperation) => op === "add_days" ? "Quantidade de dias" : "Quantidade"
  return <>
    {options.length > 1 ? <Choice id={`act-fieldop-${index}`} label="Operação" value={operation} disabled={off || !field} options={options} onChange={chooseOperation} /> : null}
    {operation === "set" && field?.type !== "text" ? <FieldValue key={`${index}-${action.field_id}`} id={`act-value-${index}`} field={field} value={action.value} disabled={off} onChange={value => change({ ...action, value })} /> : null}
    {operation === "set" && field?.type === "text" ? <div className="space-y-1">
      <Label htmlFor={`act-value-${index}`}>Valor</Label>
      <Input id={`act-value-${index}`} ref={ref} value={textValue} disabled={off} onChange={e => change({ ...action, value: e.target.value })} />
      <VariablePicker {...variableProps} targetRef={ref} value={textValue} onChange={value => change({ ...action, value })} disabled={off} />
      <p className="text-xs text-text-muted">Pode usar outro campo como valor; o texto de reserva entra quando ele estiver vazio.</p>
    </div> : null}
    {operation === "add" || operation === "subtract" || operation === "add_days" ? <div className="space-y-1">
      <Label htmlFor={`act-value-${index}`}>{operand(operation)}</Label>
      <Input id={`act-value-${index}`} ref={ref} inputMode={operation === "add_days" ? "numeric" : "decimal"} disabled={off} value={textValue}
        onChange={e => change({ ...action, value: e.target.value })} />
      <VariablePicker {...variableProps} targetRef={ref} value={textValue} onChange={value => change({ ...action, value })} disabled={off} />
      <p className="text-xs text-text-muted">{operation === "add_days" ? "Use um número negativo para voltar no tempo. Campo vazio parte de hoje." : "Campo vazio conta como zero. Pode usar o valor de outro campo, com texto de reserva."}</p>
    </div> : null}
    {operation === "clear" ? <p className="text-xs text-text-muted">Remove o valor salvo neste campo para o contato.</p> : null}
    {operation === "set_now" ? <p className="text-xs text-text-muted">Grava a data{field?.type === "datetime" ? " e a hora" : ""} em que a ação roda.</p> : null}
  </>
}
