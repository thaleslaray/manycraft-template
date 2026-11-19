import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest as request, seedAuth } from './auth-helpers'
import { receiveReply } from '../src/email-channel/receive'
import { sendEmailPart } from '../src/email-channel/service'
import { app } from '../src/index'
import { connectionRuntime } from '../src/channels/core/runtime'

beforeEach(async () => {
  await seedAuth()
})
const write = (method: string, body: unknown) => ({
  method,
  body: JSON.stringify(body),
})
const json = async (path: string, init?: RequestInit) =>
  (await request(`email/${path}`, 'a', init)).json() as Promise<any>
it('persiste remetente padrão, dados legais, múltiplos endereços e confirmação simulada sem liberar DNS antes', async () => {
  const settings = await json('settings')
  expect(settings.senders[0]).toMatchObject({
    address: 'workspace-a@mail.replica.test',
    isDefault: true,
    status: 'verified',
  })
  expect(
    (await request('email/senders', 'a', write('POST', { address: 'dono@gmail.com', name: 'Dono' }))).status,
  ).toBe(400)
  const sender = await json('senders', write('POST', { address: 'novidades@empresa.test', name: 'Empresa' }))
  expect(sender).toMatchObject({ status: 'unverified', dns: [] })
  expect(
    (
      await request(
        `email/senders/${sender.id}/verify`,
        'a',
        write('POST', { stage: 'dns', warmupAccepted: true }),
      )
    ).status,
  ).toBe(409)
  expect(await json(`senders/${sender.id}/verify`, write('POST', { stage: 'address' }))).toMatchObject({
    status: 'dns_pending',
  })
  expect(
    await json(`senders/${sender.id}/verify`, write('POST', { stage: 'dns', warmupAccepted: true })),
  ).toMatchObject({ status: 'verified' })
  await json(
    'settings',
    write('PATCH', {
      company: { name: 'Minha empresa', address: 'Rua de teste, 123' },
      defaultSenderId: sender.id,
    }),
  )
  expect(await json('settings')).toMatchObject({
    company: { name: 'Minha empresa', address: 'Rua de teste, 123' },
    defaultSenderId: sender.id,
  })
  expect((await request('email/settings', 'b', write('PATCH', { defaultSenderId: sender.id }))).status).toBe(
    400,
  )
})
it('envia teste falso, só recebe resposta correlacionada, deduplica, registra aberturas e descadastra só marketing', async () => {
  const settings = await json('settings')
  await json(
    'settings',
    write('PATCH', {
      company: { name: 'Minha empresa', address: 'Rua de teste, 123' },
    }),
  )
  const sent = await json(
    'test',
    write('POST', {
      senderId: settings.defaultSenderId,
      to: 'Cliente@exemplo.test',
      subject: 'Novidades',
      preheader: 'Veja agora',
      text: 'Olá',
      html: '<a href="https://example.test/acao">Ação</a>',
      consent: true,
    }),
  )
  expect(sent).toMatchObject({ simulated: true, to: 'cliente@exemplo.test' })
  const outbound = await env.DB.prepare('SELECT * FROM email_messages WHERE id=?').bind(sent.id).first<any>()
  expect(outbound.html).toContain('/api/email-public/unsubscribe/')
  expect(
    await receiveReply(env, {
      from: 'intruso@exemplo.test',
      to: 'reply@mail.replica.test',
      messageId: 'stray',
      text: 'Olá',
    }),
  ).toEqual({ accepted: false })
  const reply = {
    from: 'cliente@exemplo.test',
    to: outbound.reply_to,
    messageId: 'reply-1',
    inReplyTo: outbound.message_id,
    text: 'STOP',
  }
  expect(await receiveReply(env, reply)).toMatchObject({ accepted: true })
  expect(await receiveReply(env, reply)).toMatchObject({
    accepted: true,
    duplicate: true,
  })
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM messages WHERE external_message_id LIKE '%:reply-1'",
    ).first(),
  ).toEqual({ n: 1 })
  const cc = await env.DB.prepare(
    'SELECT opted_in,window_expires_at FROM contact_channels WHERE channel_id=?',
  )
    .bind(outbound.connection_id)
    .first()
  expect(cc).toEqual({ opted_in: 0, window_expires_at: null })
  const rt = await connectionRuntime(env, 'a', outbound.connection_id, {
    secrets: false,
  })
  expect(
    await sendEmailPart(
      env,
      rt.connection,
      { kind: 'direct', externalUserId: reply.from },
      { kind: 'text', text: 'Marketing' },
      'broadcast',
    ),
  ).toMatchObject({ ok: false, reason: 'not_opted_in' })
  expect(
    await sendEmailPart(
      env,
      rt.connection,
      { kind: 'direct', externalUserId: reply.from },
      { kind: 'text', text: 'Resposta humana' },
      'human',
    ),
  ).toMatchObject({ ok: true })
  const pixel = await app.request(`https://engine.test/api/email-public/open/${outbound.token}.gif`, {}, env)
  expect(pixel.status).toBe(200)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM email_events WHERE type='opened'").first()).toEqual({
    n: 1,
  })
})
it('protege mutações por papel, e produção não envia marketing pelo Email Service', async () => {
  const settings = await json('settings')
  await json('settings', write('PATCH', { company: { name: 'Empresa', address: 'Rua teste' } }))
  const sent = await json(
    'test',
    write('POST', {
      senderId: settings.defaultSenderId,
      to: 'production@example.test',
      subject: 'Teste',
      text: 'Conteúdo',
      consent: true,
    }),
  )
  const mail = await env.DB.prepare('SELECT connection_id FROM email_messages WHERE id=?')
    .bind(sent.id)
    .first<any>()
  const rt = await connectionRuntime(env, 'a', mail.connection_id, {
      secrets: false,
    }),
    transport = vi.fn()
  expect(
    await sendEmailPart(
      { ...env, APP_ENV: 'production', EMAIL: { send: transport } },
      rt.connection,
      { kind: 'direct', externalUserId: 'production@example.test' },
      { kind: 'text', text: 'Marketing' },
      'broadcast',
    ),
  ).toMatchObject({
    ok: false,
    reason: 'rejected',
    code: 'marketing_cloudflare_unsupported',
  })
  expect(transport).not.toHaveBeenCalled()
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE workspace_id='a'").run()
  expect(
    (await request('email/senders', 'a', write('POST', { address: 'x@empresa.test', name: 'X' }))).status,
  ).toBe(403)
  await env.DB.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id='a'").run()
})
it('persiste o design no rascunho, aplica somente no nó escolhido e mantém publicação congelada', async () => {
  const draft = await json(
    'drafts',
    write('POST', {
      name: 'Boas-vindas',
      subject: 'Olá {{first_name|pessoa}}',
      preheader: 'Sua reserva',
      text: 'Conteúdo do e-mail',
      html: '<h1>Conteúdo</h1>',
      design: { type: 'page', children: [] },
      onOpen: { mode: 'once', actions: [{ type: 'add_tag', tag_id: 'tag-a' }] },
    }),
  )
  expect(await json('drafts')).toContainEqual(
    expect.objectContaining({
      id: draft.id,
      name: 'Boas-vindas',
      html: '<h1>Conteúdo</h1>',
    }),
  )
  const applied = await json(
    `drafts/${draft.id}/automation-node`,
    write('POST', { automationId: 'auto-a', nodeId: 'm' }),
  )
  expect(applied).toEqual({
    automationId: 'auto-a',
    nodeId: 'm',
    hasUnpublishedChanges: true,
  })
  const automation = await env.DB.prepare(
    "SELECT draft_graph,published_version_id,has_unpublished_changes FROM automations WHERE id='auto-a'",
  ).first<any>()
  expect(JSON.parse(automation.draft_graph).nodes.find((node: any) => node.id === 'm').config).toMatchObject({
    email: {
      subject: 'Olá {{first_name|pessoa}}',
      html: '<h1>Conteúdo</h1>',
      onOpen: { mode: 'once' },
    },
    blocks: [{ kind: 'text', text: 'Conteúdo do e-mail' }],
  })
  expect(automation.published_version_id).toBeNull()
})
it('tracking dispara tag só na primeira abertura e link faz ação com destino guardado no servidor', async () => {
  const settings = await json('settings')
  await json('settings', write('PATCH', { company: { name: 'Empresa', address: 'Rua teste' } }))
  const sent = await json(
    'test',
    write('POST', {
      senderId: settings.defaultSenderId,
      to: 'tracking@example.test',
      subject: 'Teste',
      text: 'Conteúdo',
      html: '<a href="https://example.test/seguir">Seguir</a>',
      consent: true,
      onOpen: { mode: 'once', actions: [{ type: 'add_tag', tag_id: 'tag-a' }] },
      linkActions: [
        {
          url: 'https://example.test/seguir',
          actions: [{ type: 'remove_tag', tag_id: 'tag-a' }],
        },
      ],
    }),
  )
  const mail = await env.DB.prepare('SELECT * FROM email_messages WHERE id=?').bind(sent.id).first<any>()
  const trackingUrl = mail.html.match(/src="([^"]+\/open\/[^\"]+)/)[1]
  expect((await app.request(trackingUrl, {}, env)).status).toBe(200)
  expect(
    await env.DB.prepare('SELECT tag_id FROM contact_tags WHERE contact_id=?').bind(mail.contact_id).all(),
  ).toMatchObject({ results: [{ tag_id: 'tag-a' }] })
  const link = mail.html.match(/href="([^"]+\/click\/[^\"]+)/)[1]
  const click = await app.request(link, {}, env)
  expect(click.status).toBe(302)
  expect(click.headers.get('location')).toBe('https://example.test/seguir')
  expect(
    (await env.DB.prepare('SELECT tag_id FROM contact_tags WHERE contact_id=?').bind(mail.contact_id).all())
      .results,
  ).toHaveLength(0)
  await app.request(trackingUrl, {}, env)
  expect(
    (await env.DB.prepare('SELECT tag_id FROM contact_tags WHERE contact_id=?').bind(mail.contact_id).all())
      .results,
  ).toHaveLength(0)
  const profile = await json(`contacts/${mail.contact_id}`)
  expect(profile).toMatchObject({
    metrics: { opens: 2, clicks: 1 },
    segment: 'opened_clicked',
  })
})
it('bounce temporário preserva marketing; permanente retira opt-in e baixa reputação pausa os próximos envios', async () => {
  const settings = await json('settings')
  await json('settings', write('PATCH', { company: { name: 'Empresa', address: 'Rua teste' } }))
  const sent = await json(
    'test',
    write('POST', {
      senderId: settings.defaultSenderId,
      to: 'bounce@example.test',
      subject: 'Teste',
      text: 'Conteúdo',
      consent: true,
    }),
  )
  expect(
    (await request('email/dev/events', 'a', write('POST', { id: sent.id, type: 'soft_bounce' }))).status,
  ).toBe(200)
  const mail = await env.DB.prepare('SELECT * FROM email_messages WHERE id=?').bind(sent.id).first<any>()
  expect(
    await env.DB.prepare('SELECT opted_in FROM contact_channels WHERE contact_id=?')
      .bind(mail.contact_id)
      .first(),
  ).toEqual({ opted_in: 1 })
  // Um envio só não mede reputação: a pausa espera a amostra mínima.
  expect((await json('settings')).usage).toMatchObject({ paused: false, pauseReason: null })
  const cols = Object.keys(mail).filter(k => !['id','token','message_id'].includes(k))
  for (let i = 0; i < 19; i++) await env.DB.prepare(`INSERT INTO email_messages (id,token,message_id,${cols.join(',')}) SELECT ?,?,?,${cols.join(',')} FROM email_messages WHERE id=?`).bind(`amostra-${i}`, `token-amostra-${i}`, `<amostra-${i}@teste>`, sent.id).run()
  await json('settings', write('PATCH', { thresholds: { bounce: 0.01, unsubscribe: 0.02, complaint: 0.001 } }))
  await request('email/dev/events', 'a', write('POST', { id: sent.id, type: 'soft_bounce' }))
  expect((await json('settings')).usage).toMatchObject({ paused: true, pauseReason: 'bounce' })
  // Retomar pela API limpa o motivo.
  await json('settings', write('PATCH', { paused: false }))
  expect((await json('settings')).usage).toMatchObject({ paused: false, pauseReason: null })
  await json('settings', write('PATCH', { paused: true }))
  expect((await json('settings')).usage).toMatchObject({ paused: true, pauseReason: 'manual' })
  await json('dev/events', write('POST', { id: sent.id, type: 'hard_bounce' }))
  expect(
    await env.DB.prepare('SELECT opted_in FROM contact_channels WHERE contact_id=?')
      .bind(mail.contact_id)
      .first(),
  ).toEqual({ opted_in: 0 })
})
it('resposta humana preserva assunto e encadeia o último Message-ID recebido; falhas conhecidas não viram sucesso', async () => {
  const settings = await json('settings')
  await json('settings', write('PATCH', { company: { name: 'Empresa', address: 'Rua teste' } }))
  const sent = await json(
    'test',
    write('POST', {
      senderId: settings.defaultSenderId,
      to: 'thread@example.test',
      subject: 'Pedido 42',
      text: 'Seu pedido',
      consent: true,
    }),
  )
  const mail = await env.DB.prepare('SELECT * FROM email_messages WHERE id=?').bind(sent.id).first<any>()
  await receiveReply(env, {
    from: mail.recipient,
    to: mail.reply_to,
    messageId: '<reply-client@example.test>',
    inReplyTo: mail.message_id,
    text: 'Preciso de ajuda',
  })
  const rt = await connectionRuntime(env, 'a', mail.connection_id, { secrets: false }),
    transport = vi.fn().mockResolvedValue({ messageId: '<provider-confirmed@example.test>' })
  const production = { ...env, APP_ENV: 'production', EMAIL: { send: transport } }
  expect(
    await sendEmailPart(
      production,
      rt.connection,
      { kind: 'direct', externalUserId: mail.recipient },
      { kind: 'text', text: 'Como posso ajudar?' },
      'human',
    ),
  ).toMatchObject({ ok: true, externalId: '<provider-confirmed@example.test>' })
  expect(transport).toHaveBeenCalledWith(
    expect.objectContaining({
      subject: 'Re: Pedido 42',
      headers: expect.objectContaining({
        'In-Reply-To': '<reply-client@example.test>',
        References: mail.message_id,
      }),
    }),
  )
  expect(transport.mock.calls[0][0].headers).not.toHaveProperty('Message-ID')
  transport.mockRejectedValueOnce({ code: 'E_RATE_LIMIT_EXCEEDED' })
  expect(
    await sendEmailPart(
      production,
      rt.connection,
      { kind: 'direct', externalUserId: mail.recipient },
      { kind: 'text', text: 'Outra resposta' },
      'human',
    ),
  ).toMatchObject({ ok: false, reason: 'rate_limited' })
  transport.mockResolvedValueOnce({})
  expect(
    await sendEmailPart(
      production,
      rt.connection,
      { kind: 'direct', externalUserId: mail.recipient },
      { kind: 'text', text: 'Sem confirmação' },
      'human',
    ),
  ).toMatchObject({ ok: false, reason: 'uncertain' })
})
it('campo e-mail definido inicia só automação publicada, uma vez a cada 30s, sem executar regra de outro workspace', async () => {
  const graph = {
    nodes: [
      { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'm',
        type: 'message',
        position: { x: 100, y: 0 },
        config: { blocks: [{ kind: 'text', text: 'Boas-vindas' }] },
      },
    ],
    edges: [{ from: 't', port: 'next', to: 'm' }],
  }
  await env.DB.prepare(
    "INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('email-rule-version','a','auto-a',1,?)",
  )
    .bind(JSON.stringify(graph))
    .run()
  await env.DB.prepare(
    "UPDATE automations SET status='live',published_version_id='email-rule-version' WHERE workspace_id='a' AND id='auto-a'",
  ).run()
  await env.DB.prepare(
    "INSERT INTO rules(id,workspace_id,name,kind,event_type,event_config,status,action_type,automation_id) VALUES ('email-rule','a','Endereço definido','internal_event','change_system_field_value','{\"field\":\"email\"}','active','start_flow','auto-a')",
  ).run()
  const create = vi.fn().mockResolvedValue({}),
    get = vi.fn()
  const { runEmailFieldRules } = await import('../src/email-channel/events')
  await runEmailFieldRules(
    { ...env, FLOW_RUN: { create, get } as any },
    'a',
    'c-a',
    'ch-a',
    null,
    'first@example.test',
  )
  await runEmailFieldRules(
    { ...env, FLOW_RUN: { create, get } as any },
    'a',
    'c-a',
    'ch-a',
    'first@example.test',
    'second@example.test',
  )
  expect(create).toHaveBeenCalledTimes(1)
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM flow_runs WHERE workspace_id='a' AND contact_id='c-a'",
    ).first(),
  ).toEqual({ n: 1 })
  await runEmailFieldRules(
    { ...env, FLOW_RUN: { create, get } as any },
    'b',
    'c-b',
    'ch-b',
    null,
    'third@example.test',
  )
  expect(create).toHaveBeenCalledTimes(1)
})
it('métricas por transmissão contam clique e CTR somente no primeiro nó e não misturam outro envio', async () => {
  const settings = await json('settings')
  await json('settings', write('PATCH', { company: { name: 'Empresa', address: 'Rua teste' } }))
  const ids = []
  for (const nodeId of ['first', 'second']) {
    const sent = await json(
      'test',
      write('POST', {
        senderId: settings.defaultSenderId,
        to: 'stats@example.test',
        subject: nodeId,
        text: 'Conteúdo',
        html: '<a href="https://example.test/stats">Ver</a>',
        consent: true,
      }),
    )
    await env.DB.prepare('UPDATE email_messages SET metadata=? WHERE id=?')
      .bind(JSON.stringify({ source: { broadcastId: 'campaign-a', nodeId } }), sent.id)
      .run()
    ids.push(sent.id)
  }
  const click = async (id: string) => {
    const mail = await env.DB.prepare('SELECT html FROM email_messages WHERE id=?').bind(id).first<any>()
    return app.request(mail.html.match(/href="([^"]+\/click\/[^\"]+)/)[1], {}, env)
  }
  await click(ids[1])
  expect(await json('metrics?broadcastId=campaign-a')).toMatchObject({
    sent: 2,
    clicked: 0,
    ctr: 0,
    firstNodeId: 'first',
  })
  await click(ids[0])
  expect(await json('metrics?broadcastId=campaign-a')).toMatchObject({
    sent: 2,
    clicked: 1,
    ctr: 1,
    firstNodeId: 'first',
  })
  expect(await json('metrics?broadcastId=missing')).toMatchObject({ sent: 0, clicked: 0, ctr: 0 })
})
