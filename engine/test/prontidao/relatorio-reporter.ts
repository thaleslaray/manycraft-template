/**
 * Relatório do teste de prontidão: lê o resultado de cada teste (e os elos/tempos que a jornada e o estresse guardam em `task.meta`)
 * e escreve `.scratch/prontidao/relatorio.md`. Usado só por `npm run prontidao`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Reporter, TestModule } from 'vitest/node'

type Linha = { nome: string; canal: string; tipo: 'jornada' | 'contrato' | 'estresse' | 'roteamento'; ok: boolean; ms: number; erro?: string; elos: { nome: string; ok: boolean; ms: number; erro?: string }[]; estresse?: Record<string, unknown> }
const tira = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '')

function classificar(nome: string): Pick<Linha, 'canal' | 'tipo'> {
  const canal = /^\[([^\]]+)\]/.exec(nome)?.[1]
  if (/roteamento|Conversation Routing|131070|iniciar conversa/i.test(nome)) return { canal: 'whatsapp_cloud', tipo: 'roteamento' }
  const tipo = /estresse/.test(nome) ? 'estresse' : /contrato/.test(nome) ? 'contrato' : 'jornada'
  return { canal: canal ?? 'geral', tipo }
}

export default class RelatorioProntidao implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>) {
    const linhas: Linha[] = []
    for (const modulo of modules) for (const t of modulo.children.allTests()) {
      if (!modulo.moduleId.includes('/test/prontidao/')) continue
      const r = t.result(), meta = t.meta()
      if (r.state === 'skipped' || r.state === 'pending') continue
      const nome = t.fullName
      linhas.push({ nome, ...classificar(`${modulo.moduleId.split('/').at(-1)} ${nome}`.replace(/^\S+ /, '')), ok: r.state === 'passed', ms: Math.round(t.diagnostic()?.duration ?? 0),
        ...(r.state === 'failed' ? { erro: tira(r.errors?.map(e => e.message).join(' | ') ?? 'falhou') } : {}), elos: meta.elos ?? [], ...(meta.estresse ? { estresse: meta.estresse } : {}) })
    }
    const caminho = resolve(process.env.PRONTIDAO_RELATORIO ?? resolve(process.cwd(), '../.scratch/prontidao/relatorio.md'))
    const notas = (() => { try { return readFileSync(resolve(dirname(caminho), 'relatorio-notas.md'), 'utf8').trim() } catch { return '' } })()
    mkdirSync(dirname(caminho), { recursive: true })
    writeFileSync(caminho, montar(linhas, notas))
    const vermelhos = linhas.filter(l => !l.ok).length
    console.log(`\nRelatório de prontidão: ${caminho} (${linhas.length - vermelhos} verdes, ${vermelhos} vermelhos)`)
  }
}

const icone = (ok: boolean) => ok ? 'verde' : 'VERMELHO'
function montar(linhas: Linha[], notas: string): string {
  const hoje = new Date().toISOString().slice(0, 10)
  const por = (tipo: Linha['tipo']) => linhas.filter(l => l.tipo === tipo)
  const vermelhos = linhas.filter(l => !l.ok)
  const out: string[] = [`# Relatório de prontidão (${hoje})`, '',
    `Simuladores no lugar das contas reais: nada tocou canal de verdade. ${linhas.length - vermelhos.length} verdes, ${vermelhos.length} vermelhos.`, '']
  out.push('## Jornada do usuário novo, por canal', '', 'Conectar → sincronizar modelos → fluxo com palavra-chave → publicar → contato manda a palavra → botão → condição → ação → transmissão com modelo.', '')
  for (const l of por('jornada')) {
    out.push(`### ${l.canal}: ${icone(l.ok)}`, '', '| Elo | Resultado | Tempo |', '|---|---|---|')
    for (const e of l.elos) out.push(`| ${e.nome} | ${icone(e.ok)}${e.erro ? `: ${e.erro.replace(/\|/g, '/').slice(0, 200)}` : ''} | ${e.ms} ms |`)
    if (!l.elos.length) out.push(`| (teste inteiro) | ${icone(l.ok)}${l.erro ? `: ${l.erro.slice(0, 200)}` : ''} | ${l.ms} ms |`)
    out.push('')
  }
  out.push('## Contrato dos provedores (erros, duplicados, fora de ordem)', '', '| Canal | Teste | Resultado |', '|---|---|---|')
  for (const l of por('contrato')) out.push(`| ${l.canal} | ${l.nome.replace(/\|/g, '/')} | ${icone(l.ok)} |`)
  out.push('')
  const rot = por('roteamento')
  if (rot.length) { out.push('## Conversation Routing e conversa iniciada pela caixa de entrada', '', '| Teste | Resultado |', '|---|---|'); for (const l of rot) out.push(`| ${l.nome.replace(/\|/g, '/')} | ${icone(l.ok)} |`); out.push('') }
  for (const l of por('estresse')) {
    out.push(`## Estresse: ${icone(l.ok)}`, '', `Duração: ${(l.ms / 1000).toFixed(1)} s.`, '', '```json', JSON.stringify(l.estresse ?? {}, null, 2), '```', '')
    for (const e of l.elos) out.push(`- ${e.nome}: ${icone(e.ok)} (${e.ms} ms)${e.erro ? ` ${e.erro.slice(0, 200)}` : ''}`)
    out.push('')
  }
  out.push('## O que corrigir', '')
  if (!vermelhos.length) out.push('Nada vermelho nesta rodada.')
  for (const l of vermelhos) out.push(`- **${l.canal} / ${l.tipo}: ${l.nome}**`, `  ${(l.erro ?? '').slice(0, 600).replace(/\n/g, ' ')}`)
  if (notas) out.push('', notas)
  return out.join('\n') + '\n'
}
