/** CSV with quoted cells, escaped quotes, BOM, comma/semicolon and CRLF. No I/O. */
export function parseContactCsv(source: string): { headers: string[]; rows: string[][] } {
  const text = source.replace(/^\uFEFF/, '')
  if (!text.trim()) throw new Error('O arquivo está vazio.')
  // Detect the delimiter on the header, excluding separators inside quoted cells.
  let quoted = false, commas = 0, semicolons = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { i++; continue }
      quoted = !quoted
    }
    if (!quoted && (char === '\n' || char === '\r')) break
    if (!quoted && char === ',') commas++
    if (!quoted && char === ';') semicolons++
  }
  const delimiter = semicolons > commas ? ';' : ','
  const records: string[][] = []
  let row: string[] = [], cell = '', inQuote = false, closed = false
  const endCell = () => { row.push(cell); cell = ''; closed = false }
  const endRow = () => {
    endCell()
    if (row.some(value => value.trim())) records.push(row)
    row = []
    if (records.length > 20_001) throw new Error('Divida o arquivo em lotes de até 20.000 linhas.')
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuote) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (char === '"') { inQuote = false; closed = true }
      else cell += char
    } else if (char === delimiter) endCell()
    else if (char === '\n' || char === '\r') { endRow(); if (char === '\r' && text[i + 1] === '\n') i++ }
    else if (char === '"' && !cell && !closed) inQuote = true
    else if (char === '"' || closed) throw new Error('Há aspas fora do lugar no CSV.')
    else cell += char
    if (row.length > 100 || cell.length > 10_000) throw new Error('O CSV excede o limite de 100 colunas ou 10.000 caracteres por célula.')
  }
  if (inQuote) throw new Error('Há uma célula com aspas sem fechamento.')
  if (cell || closed || row.length) endRow()
  const headers = records.shift()?.map(value => value.trim()) ?? []
  if (!headers.length || headers.length > 100 || headers.some(value => !value)) throw new Error('Preencha um título para cada coluna na primeira linha.')
  if (!records.length) throw new Error('Inclua pelo menos uma linha de contato após o cabeçalho.')
  return { headers, rows: records }
}
