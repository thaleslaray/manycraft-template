import qrcode from "qrcode-generator"

/** QR gerado aqui, no navegador (biblioteca local, sem serviço externo). Correção de erro M: aguenta riscos e impressão ruim. */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, "H")
  qr.addData(text, "Byte")
  qr.make()
  const size = qr.getModuleCount()
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)))
}

const QUIET = 4 // margem de 4 módulos, o mínimo que o padrão do QR pede

/** Desenha o QR no canvas, quadrado, com a margem em branco. */
export type QrStyle = { dark?: string; light?: string; logo?: HTMLImageElement | null }
export function drawQr(canvas: HTMLCanvasElement, text: string, pixels: number, style: QrStyle = {}): void {
  const modules = qrModules(text)
  const total = modules.length + QUIET * 2
  const cell = Math.max(1, Math.floor(pixels / total))
  canvas.width = canvas.height = cell * total
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  ctx.fillStyle = style.light ?? "#ffffff"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = style.dark ?? "#000000"
  modules.forEach((line, row) => line.forEach((dark, col) => { if (dark) ctx.fillRect((col + QUIET) * cell, (row + QUIET) * cell, cell, cell) }))
  // Logo no centro: até 20% do lado, sobre um fundo claro (a correção de erro aguenta essa área).
  if (style.logo) {
    const side = Math.round(canvas.width * 0.2), at = Math.round((canvas.width - side) / 2)
    ctx.fillStyle = style.light ?? "#ffffff"; ctx.fillRect(at - cell, at - cell, side + cell * 2, side + cell * 2)
    ctx.drawImage(style.logo, at, at, side, side)
  }
}

/** PNG de tamanho fixo para baixar (1024 px: nítido na impressão). */
export function qrPng(text: string, pixels = 1024, style: QrStyle = {}): Promise<Blob> {
  const canvas = document.createElement("canvas")
  drawQr(canvas, text, pixels, style)
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Não consegui gerar o PNG.")), "image/png"))
}
