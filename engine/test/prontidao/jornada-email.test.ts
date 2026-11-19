import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveBroadcast, getBroadcast, consumeBroadcast } from '../../src/db/broadcasts'
import { sendEmailPart } from '../../src/email-channel/service'
import { EmailBinding, errosEmail } from './simulador-email'
import { abrirEmail, ambienteDeEnvio, CLIENTE, conectarEmail, emailsSalvos, responderEmail, verificarRemetente } from './canal-email'
import { apiJson, consumir, desligarWorkflows, elo, esperar, ligarWorkflows, prepararEspaco, sql } from './jornada'
import type { Graph } from '../../src/contracts'

beforeEach(async () => { await prepararEspaco(); await ligarWorkflows() })
afterEach(async () => { await desligarWorkflows(); vi.restoreAllMocks() })

const no = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, config })
/** Gatilho (abertura do e-mail) → e-mail de oferta → condição por etiqueta → ação (etiqueta + campo) → e-mail final. */
const grafoEmail = (): Graph => ({
  nodes: [no('start', 'trigger'),
    no('oferta', 'message', { blocks: [{ kind: 'text', text: 'Quer receber o material? Responda este e-mail.' }], email: { subject: 'Seu material está quase aí' } }),
    no('cond', 'condition', { match: 'all', rules: [{ type: 'tag', tag_id: 'tag-a', operator: 'has' }] }),
    no('acao', 'action', { actions: [{ type: 'add_tag', tag_id: 'tag-a' }, { type: 'set_custom_field_value', field_id: 'field-a', value: 'Curso' }] }),
    no('final', 'message', { blocks: [{ kind: 'text', text: 'Material enviado, valeu!' }], email: { subject: 'Material enviado' } }),
    no('jatem', 'message', { blocks: [{ kind: 'text', text: 'Você já recebeu.' }] })] as Graph['nodes'],
  edges: [{ from: 'start', port: 'next', to: 'oferta' }, { from: 'oferta', port: 'next', to: 'cond' }, { from: 'cond', port: 'false', to: 'acao' },
    { from: 'cond', port: 'true', to: 'jatem' }, { from: 'acao', port: 'next', to: 'final' }],
})

it('[email] jornada: conectar → fluxo → e-mail aberto → resposta → condição → ação → transmissão', async ({ task }) => {
  const canalId = await elo(task, 'conectar (empresa + remetente verificado)', async () => {
    const id = await conectarEmail()
    await verificarRemetente()
    return id
  })
  await elo(task, 'criar e publicar fluxo + regra "quando abrir o e-mail"', async () => {
    await apiJson('PUT', 'automations/auto-a/draft', { graph: grafoEmail() })
    await apiJson('POST', 'automations/auto-a/publish', undefined, 201)
    const regra = await apiJson<any>('POST', 'email/rules', { name: 'Abriu o e-mail', event: 'email_opened', automationId: 'auto-a', frequency: 'once', active: true }, 201)
    expect(regra).toMatchObject({ event: 'email_opened', active: true })
  })
  let inicial!: Awaited<ReturnType<typeof emailsSalvos>>[number]
  await elo(task, 'primeiro e-mail ao contato (envio de teste com consentimento)', async () => {
    const cfg = await apiJson<any>('GET', 'email/settings')
    await apiJson('POST', 'email/test', { senderId: cfg.defaultSenderId, to: CLIENTE, subject: 'Bem-vindo', text: 'Olá! Abra este e-mail para continuar.', consent: true })
    const e = await emailsSalvos()
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ recipient: CLIENTE, subject: 'Bem-vindo', status: 'sent' })
    inicial = e[0]
  })
  await elo(task, 'contato abre o e-mail → regra dispara o fluxo → recebe a oferta e o e-mail final', async () => {
    await abrirEmail(inicial.token)
    const e = await esperar('e-mail de oferta e e-mail final', emailsSalvos, v => v.length >= 3)
    expect(e.map(x => x.subject)).toEqual(['Bem-vindo', 'Seu material está quase aí', 'Material enviado'])
    expect(e[1].text).toContain('Quer receber o material?')
    expect(e[2].text).toContain('Material enviado, valeu!')
    expect(e.every(x => x.recipient === CLIENTE && x.status === 'sent')).toBe(true)
    const run = await esperar('execução concluída', () => sql.um<{ status: string }>("SELECT status FROM flow_runs WHERE workspace_id='a' ORDER BY created_at DESC LIMIT 1"), v => v?.status === 'done')
    expect(run?.status).toBe('done')
  })
  await elo(task, 'condição → ação gravou etiqueta e campo no contato', async () => {
    expect(await sql.n("SELECT count(*) n FROM contact_tags WHERE contact_id=? AND tag_id='tag-a'", inicial.contact_id)).toBe(1)
    const valor = await sql.um<{ value: string }>("SELECT value FROM contact_field_values WHERE contact_id=? AND field_id='field-a'", inicial.contact_id)
    expect(JSON.parse(valor!.value)).toBe('Curso')
  })
  await elo(task, 'contato responde o e-mail (MIME real) → cai na caixa de entrada, sem iniciar outro fluxo', async () => {
    const runs = await sql.n('SELECT count(*) n FROM flow_runs')
    const ultimo = (await emailsSalvos()).at(-1)!
    const r = await responderEmail(ultimo, 'Quero sim, obrigado!', '<resp-1@mail.exemplo.test>')
    expect(r.recusada, 'resposta a um e-mail da plataforma não pode ser recusada').toEqual([])
    expect(r.eventos).toHaveLength(1)
    await consumir(r.eventos)
    const msg = await sql.um<{ content: string }>("SELECT content FROM messages WHERE workspace_id='a' AND direction='in' ORDER BY created_at DESC LIMIT 1")
    expect(JSON.parse(msg!.content).text).toContain('Quero sim, obrigado!')
    await new Promise(r => setTimeout(r, 150))
    expect(await sql.n('SELECT count(*) n FROM flow_runs'), 'não existe gatilho de palavra-chave para e-mail: a resposta não pode criar execução').toBe(runs)
  })
  await elo(task, 'transmissão de e-mail para o contato', async () => {
    await new Promise(r => setTimeout(r, 1200))   // o limitador deixa 1 mensagem por segundo por conversa
    const antes = (await emailsSalvos()).length
    const local = { ...env, INBOUND: { send: async () => {} } as unknown as Queue }
    const principal = { userId: 'test-owner', workspaceId: 'a', role: 'owner' as const }
    const cfg = await apiJson<any>('GET', 'email/settings')
    const canal = (await apiJson<any[]>('GET', 'connections')).find(c => c.kind === 'email')
    const b = await saveBroadcast(local as never, principal, { name: 'Novidades', content: 'Chegou a novidade da semana.', email: { senderId: cfg.defaultSenderId, subject: 'Novidade da semana', html: '<p>Chegou a novidade da semana.</p>' }, status: 'sending', audience: { tag: 'all', channel: 'email', channel_id: canal.id } } as never)
    await consumeBroadcast({ body: { kind: 'broadcast', workspaceId: 'a', broadcastId: b.id }, ack: () => {}, retry: () => { throw new Error('a transmissão pediu nova tentativa') } } as never, local as never)
    const final = await getBroadcast(local as never, principal, b.id)
    const resumo = JSON.stringify({ status: (final as any).status, metrics: final.metrics, emails: (await emailsSalvos()).slice(antes).map(e => [e.status, e.intent]) })
    expect((final.metrics as any).sent, resumo).toBe(1)
    const novas = (await emailsSalvos()).slice(antes)
    expect(novas).toHaveLength(1)
    const n0 = novas[0], vis = JSON.stringify({ r: n0.recipient, s: n0.subject, i: n0.intent, st: n0.status })
    expect(n0.recipient, vis).toBe(CLIENTE); expect(n0.subject, vis).toBe('Novidade da semana'); expect(n0.intent, vis).not.toBe('human')
    expect(n0.html).toContain('/api/email-public/unsubscribe/')
    expect(canalId).toBe(canal.id)
  })
}, 60000)

// ───────────────────────────── contrato ─────────────────────────────
async function publicarComRegra(evento: 'email_opened' | 'contact_created' = 'email_opened') {
  await apiJson('PUT', 'automations/auto-a/draft', { graph: grafoEmail() })
  await apiJson('POST', 'automations/auto-a/publish', undefined, 201)
  await apiJson('POST', 'email/rules', { name: 'Regra', event: evento, automationId: 'auto-a', frequency: 'once', active: true }, 201)
}
async function primeiroEmail() {
  const cfg = await apiJson<any>('GET', 'email/settings')
  await apiJson('POST', 'email/test', { senderId: cfg.defaultSenderId, to: CLIENTE, subject: 'Bem-vindo', text: 'Olá! Abra este e-mail para continuar.', consent: true })
  return (await emailsSalvos())[0]
}
const contagem = async () => ({ runs: await sql.n('SELECT count(*) n FROM flow_runs'), emails: (await emailsSalvos()).length, entrada: await sql.n("SELECT count(*) n FROM messages WHERE workspace_id='a' AND direction='in'"), contatos: await sql.n("SELECT count(*) n FROM contacts WHERE workspace_id='a'") })

it('[email] contrato: e-mail recebido duplicado não duplica execução; desconhecido é recusado', async () => {
  await conectarEmail()
  await publicarComRegra()
  const inicial = await primeiroEmail()
  // 1. quem não é resposta a um e-mail nosso é recusado e não cria contato (nem conversa)
  const antes = await contagem()
  const frio = await responderEmail(inicial, 'Oi, quero comprar', '<frio-1@mail.exemplo.test>', { emResposta: null, de: 'estranho@exemplo.test', para: 'workspace-a@mail.replica.test' })
  expect(frio.recusada, 'e-mail frio (sem In-Reply-To nem token) deveria ser recusado').toHaveLength(1)
  expect(frio.eventos).toHaveLength(0)
  const intruso = await responderEmail(inicial, 'Sou outra pessoa', '<intruso-1@mail.exemplo.test>', { de: 'intruso@exemplo.test' })
  expect(intruso.recusada, 'resposta de outro remetente a um e-mail nosso deveria ser recusada').toHaveLength(1)
  expect(await contagem()).toEqual(antes)

  // 2. a mesma mensagem (mesmo Message-ID) duas vezes: uma caixa de entrada, um evento na fila
  const r1 = await responderEmail(inicial, 'Quero sim', '<dup-1@mail.exemplo.test>')
  const r2 = await responderEmail(inicial, 'Quero sim', '<dup-1@mail.exemplo.test>')
  expect(r1.recusada).toEqual([]); expect(r2.recusada).toEqual([])
  expect(r1.eventos.length + r2.eventos.length, 'eventos enviados à fila para o mesmo Message-ID').toBe(1)
  expect(await sql.n("SELECT count(*) n FROM messages WHERE workspace_id='a' AND direction='in'")).toBe(antes.entrada + 1)
  expect(await sql.n("SELECT count(*) n FROM email_receipts WHERE workspace_id='a' AND message_id='<dup-1@mail.exemplo.test>'")).toBe(1)
  // reentrega da fila (at-least-once): consumir o mesmo evento duas vezes não cria execução nem mensagem
  await consumir(r1.eventos); await consumir(r1.eventos)
  await new Promise(r => setTimeout(r, 150))
  expect(await sql.n("SELECT count(*) n FROM messages WHERE workspace_id='a' AND direction='in'")).toBe(antes.entrada + 1)
  expect(await sql.n('SELECT count(*) n FROM flow_runs'), 'resposta de e-mail não tem gatilho: nenhuma execução nova').toBe(antes.runs)

  // 3. abrir o e-mail duas vezes (pixel repetido) inicia o fluxo uma vez só
  await abrirEmail(inicial.token); await abrirEmail(inicial.token)
  await esperar('e-mails do fluxo', emailsSalvos, v => v.length >= 3)
  await new Promise(r => setTimeout(r, 400))
  expect((await emailsSalvos()).map(e => e.subject), 'e-mails depois de abrir duas vezes').toEqual(['Bem-vindo', 'Seu material está quase aí', 'Material enviado'])
  expect(await sql.n('SELECT count(*) n FROM flow_runs')).toBe(antes.runs + 1)
}, 60000)

it('[email] contrato: duas entregas simultâneas do mesmo Message-ID geram um evento só', async () => {
  await conectarEmail()
  await publicarComRegra()
  const inicial = await primeiroEmail()
  const [a, b] = await Promise.all([responderEmail(inicial, 'Quero sim', '<par-1@mail.exemplo.test>'), responderEmail(inicial, 'Quero sim', '<par-1@mail.exemplo.test>')])
  await consumir([...a.eventos, ...b.eventos])
  expect(await sql.n("SELECT count(*) n FROM messages WHERE workspace_id='a' AND direction='in'"), 'mensagens na caixa de entrada').toBe(1)
  expect(await sql.n('SELECT count(*) n FROM flow_runs'), 'execuções').toBe(0)
  expect(a.eventos.length + b.eventos.length, 'eventos na fila para entregas simultâneas do mesmo Message-ID').toBe(1)
}, 60000)

it('[email] contrato: resposta fora de ordem respeita a data do cabeçalho Date', async () => {
  await conectarEmail()
  const inicial = await primeiroEmail()
  const cedo = new Date(Date.now() - 3600_000), tarde = new Date(Date.now() - 60_000)
  // chega primeiro a mais nova, depois a mais antiga
  await responderEmail(inicial, 'segunda resposta (mais nova)', '<ordem-2@mail.exemplo.test>', { data: tarde })
  await responderEmail(inicial, 'primeira resposta (mais antiga)', '<ordem-1@mail.exemplo.test>', { data: cedo })
  expect(await sql.n("SELECT count(*) n FROM messages WHERE workspace_id='a' AND direction='in'")).toBe(2)
  const c = await sql.um<{ last_input_text: string }>('SELECT last_input_text FROM contacts WHERE id=?', inicial.contact_id)
  expect(c!.last_input_text, 'última resposta do contato deveria ser a de Date mais recente').toContain('segunda resposta')
  const ordem = await sql.todas<{ content: string }>("SELECT content FROM messages WHERE workspace_id='a' AND direction='in' ORDER BY created_at, rowid")
  expect(ordem.map(m => JSON.parse(m.content).text).join('|'), 'ordem da conversa deveria seguir a data do cabeçalho Date').toContain('primeira resposta (mais antiga)')
  const textos = ordem.map(m => JSON.parse(m.content).text as string)
  expect(textos.findIndex(t => t.includes('primeira')) < textos.findIndex(t => t.includes('segunda')), 'a mais antiga deveria aparecer antes na conversa').toBe(true)
}, 60000)

describe('[email] contrato: envio', () => {
  async function montar() {
    const sim = new EmailBinding('mail.replica.test', 'empresa.test')
    const amb = await ambienteDeEnvio(sim)
    const enviar = (para: string, extra: Record<string, unknown> = {}) => sendEmailPart(amb.producao, amb.connection, { kind: 'direct', externalUserId: para }, { kind: 'text', text: 'Olá, tudo bem?', email: { subject: 'Resposta da equipe', ...extra } } as never, 'human')
    return { sim, enviar, ...amb }
  }
  const linhas = (para: string) => sql.todas<{ status: string }>("SELECT status FROM email_messages WHERE workspace_id='a' AND recipient=? ORDER BY created_at, rowid", para)

  it('endereço inválido, remetente não verificado e domínio não verificado são rejeitados e não repetem', async () => {
    const { sim, enviar } = await montar()
    // endereço inválido: recusado antes de chamar o serviço
    for (const ruim of ['errado', 'a b@exemplo.test', 'x@exemplo.test\r\nBcc: y@exemplo.test']) expect(await enviar(ruim), ruim).toMatchObject({ ok: false, reason: 'rejected' })
    expect(sim.chamadas, 'endereço inválido não pode chegar ao serviço').toHaveLength(0)
    // o serviço também recusa (E_VALIDATION_ERROR): rejeitado, uma chamada só, nada marcado como enviado
    sim.programar({ erro: errosEmail.enderecoInvalido })
    expect(await enviar('valido@exemplo.test')).toMatchObject({ ok: false, reason: 'rejected', code: 'E_VALIDATION_ERROR' })
    expect(sim.chamadas).toHaveLength(1)
    expect((await linhas('valido@exemplo.test')).map(l => l.status)).toEqual(['failed'])
    // remetente cadastrado mas não verificado: recusado localmente
    const naoVerificado = await apiJson<any>('POST', 'email/senders', { address: 'sem-verificar@empresa.test', name: 'Sem verificar' }, 201)
    expect(await enviar('outro@exemplo.test', { senderId: naoVerificado.id })).toMatchObject({ ok: false, reason: 'rejected', code: 'sender_unverified' })
    expect(sim.chamadas).toHaveLength(1)
    // domínio fora da conta no serviço de envio: rejeitado com o código do serviço, sem tentar de novo
    sim.dominiosVerificados.delete('mail.replica.test')
    expect(await enviar('dominio@exemplo.test')).toMatchObject({ ok: false, reason: 'rejected', code: 'E_SENDER_DOMAIN_NOT_AVAILABLE' })
    sim.programar({ erro: errosEmail.remetenteNaoVerificado })
    sim.dominiosVerificados.add('mail.replica.test')
    expect(await enviar('naoverif@exemplo.test')).toMatchObject({ ok: false, reason: 'rejected', code: 'E_SENDER_NOT_VERIFIED' })
    expect(sim.enviadas, 'nada deveria ter sido entregue').toHaveLength(0)
    expect((await linhas('dominio@exemplo.test')).map(l => l.status)).toEqual(['failed'])
  })

  it('limite de envio é repetível e a nova tentativa não duplica a entrega', async () => {
    const { sim, enviar } = await montar()
    sim.programar({ erro: errosEmail.limite })
    const primeira = await enviar('limite@exemplo.test')
    expect(primeira).toMatchObject({ ok: false, reason: 'rate_limited' })
    expect((primeira as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(0)
    expect(sim.enviadas).toHaveLength(0)
    expect(await enviar('limite@exemplo.test')).toMatchObject({ ok: true })
    expect(sim.enviadas.filter(e => e.para === 'limite@exemplo.test'), 'entregas depois de repetir').toHaveLength(1)
    expect((await linhas('limite@exemplo.test')).map(l => l.status)).toEqual(['failed', 'sent'])
  })

  it('falha temporária 5xx (E_INTERNAL_SERVER_ERROR) é incerta: o serviço pode ter aceitado, então não reenvia sozinho', async () => {
    const { sim, enviar } = await montar()
    sim.programar({ erro: errosEmail.interno })
    // A documentação só diz "serviço temporariamente indisponível": não garante que o e-mail não saiu. Reenviar sozinho poderia duplicar.
    expect(await enviar('cinco@exemplo.test')).toMatchObject({ ok: false, reason: 'uncertain' })
    expect(sim.chamadas, 'uma chamada só, sem repetir').toHaveLength(1)
    expect((await linhas('cinco@exemplo.test')).map(l => l.status)).toEqual(['uncertain'])
  })

  it('limite diário esgotado não é repetido em poucos segundos', async () => {
    const { sim, enviar } = await montar()
    sim.programar({ erro: errosEmail.limiteDiario })
    const r = await enviar('diario@exemplo.test')
    expect(r).toMatchObject({ ok: false, reason: 'rate_limited' })
    expect((r as { retryAfterSec: number }).retryAfterSec, 'cota diária só volta no dia seguinte: a espera deveria ser de horas, não segundos').toBeGreaterThanOrEqual(3600)
  })
})
