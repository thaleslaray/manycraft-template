export type CsvContact = {
  first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null; gender?: string | null
  status: string; subscribed_at?: number | string | null; tags?: { name: string }[]
}
const statusText: Record<string, string> = { subscribed: 'Inscrito', unsubscribed: 'Cancelado', deleted: 'Excluído' }
const genderText: Record<string, string> = { female: 'Feminino', f: 'Feminino', male: 'Masculino', m: 'Masculino', other: 'Outro', non_binary: 'Outro' }
const headers = ['Nome', 'Sobrenome', 'E-mail', 'Telefone', 'Gênero', 'Status', 'Inscrito em', 'Tags']

/** Célula de CSV: aspas quando preciso e um apóstrofo na frente de texto que a planilha leria como fórmula. */
function cell(value: string | null | undefined): string {
  let text = value ?? ''
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
const day = (value: number | string | null | undefined) => value === null || value === undefined || value === '' ? '' : new Date(value).toISOString().slice(0, 10)

export function contactsCsv(contacts: CsvContact[]): string {
  const lines = contacts.map(c => [
    c.first_name, c.last_name, c.email, c.phone, c.gender ? genderText[c.gender.toLowerCase()] ?? c.gender : '',
    statusText[c.status] ?? c.status, day(c.subscribed_at), (c.tags ?? []).map(t => t.name).join('; '),
  ].map(cell).join(','))
  return `﻿${[headers.join(','), ...lines].join('\r\n')}`
}
