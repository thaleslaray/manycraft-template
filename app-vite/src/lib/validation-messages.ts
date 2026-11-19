type Validity = Partial<Record<"valueMissing" | "typeMismatch" | "patternMismatch" | "tooShort" | "tooLong" | "rangeUnderflow" | "rangeOverflow" | "stepMismatch" | "badInput", boolean>>
type Control = { type?: string; min?: string; max?: string; minLength?: number; maxLength?: number; title?: string }

/** Mensagem em pt-BR no lugar do balão nativo do navegador (que segue o idioma do sistema, em geral inglês). Vazio quando o campo é válido. */
export function validationMessage(v: Validity, el: Control): string {
  if (v.valueMissing) return el.type === "file" ? "Escolha um arquivo." : el.type === "checkbox" || el.type === "radio" ? "Marque esta opção para continuar." : "Preencha este campo."
  if (v.typeMismatch) return el.type === "email" ? "Digite um e-mail válido, como nome@exemplo.com." : el.type === "url" ? "Digite um endereço válido, começando com https://." : "Valor inválido neste campo."
  if (v.patternMismatch) return el.title || "Use o formato pedido neste campo."
  if (v.tooShort) return `Use pelo menos ${el.minLength} caracteres.`
  if (v.tooLong) return `Use no máximo ${el.maxLength} caracteres.`
  if (v.rangeUnderflow) return `Use um valor maior ou igual a ${el.min}.`
  if (v.rangeOverflow) return `Use um valor menor ou igual a ${el.max}.`
  if (v.stepMismatch) return "Use um valor válido (confira o intervalo permitido)."
  if (v.badInput) return "Valor inválido neste campo."
  return ""
}

/** Instala uma vez: todo campo que o navegador recusar mostra a mensagem acima. Devolve a função que desfaz. */
export function installValidationMessages(doc: Document = document): () => void {
  const onInvalid = (event: Event) => {
    const el = event.target as HTMLInputElement
    if (!el || typeof el.setCustomValidity !== "function") return
    el.setCustomValidity("")
    el.setCustomValidity(validationMessage(el.validity, el))
  }
  // Ao corrigir o campo a mensagem própria sairia do caminho: limpa para o navegador revalidar.
  const onInput = (event: Event) => { const el = event.target as HTMLInputElement; if (typeof el?.setCustomValidity === "function") el.setCustomValidity("") }
  doc.addEventListener("invalid", onInvalid, true)
  doc.addEventListener("input", onInput, true)
  doc.addEventListener("change", onInput, true)
  return () => { doc.removeEventListener("invalid", onInvalid, true); doc.removeEventListener("input", onInput, true); doc.removeEventListener("change", onInput, true) }
}
