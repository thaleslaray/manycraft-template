import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { buildInstagramSeed, buildTelegramSeed, demoIds, instagramIds } from './seed-telegram.mjs'
import { expectedBotUsername, parseTelegramEnv, registerWebhook, telegramCall, webhookUrl } from './telegram-webhook.mjs'

const token = '123456:TEST_ONLY_NOT_A_REAL_TOKEN'
const env = { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: 'test-secret', TELEGRAM_CHANNEL_ID: 'demo-telegram' }

function telegramMock(results) {
  const calls = []
  const fetcher = async (url, init) => {
    const method = url.split('/').at(-1)
    calls.push({ method, body: JSON.parse(init.body) })
    assert.ok(method in results, `Chamada inesperada: ${method}`)
    return { ok: true, status: 200, json: async () => ({ ok: true, result: results[method] }) }
  }
  return { calls, fetcher }
}

test('seed aplica migrações reais, cria dono Better Auth e preserva versões/identidade ao repetir', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const migrations = new URL('../migrations/', import.meta.url)
    for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
      db.exec(await readFile(new URL(file, migrations), 'utf8'))
    }
    db.exec(buildTelegramSeed('123456'))
    const owner = db.prepare(`SELECT u.id,u.email,u.emailVerified,m.role FROM "user" u
      JOIN workspace_members m ON m.user_id=u.id WHERE m.workspace_id=?`).get(demoIds.workspace)
    assert.deepEqual({ ...owner }, { id: demoIds.user, email: 'lia@example.test', emailVerified: 1, role: 'owner' })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session').get().n, 0)
    db.prepare('UPDATE "user" SET name=? WHERE id=?').run('Nome ajustado', demoIds.user)
    const graph = db.prepare('SELECT graph FROM automation_versions WHERE id=?').get(demoIds.version).graph
    db.prepare(`INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph)
      VALUES ('newer-version',?,?,2,?)`).run(demoIds.workspace, demoIds.automation, graph)
    db.prepare("UPDATE automations SET published_version_id='newer-version' WHERE id=?").run(demoIds.automation)
    db.exec(buildTelegramSeed('123456'))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=?').get(demoIds.workspace).n, 1)
    assert.equal(db.prepare('SELECT name FROM "user" WHERE id=?').get(demoIds.user).name, 'Nome ajustado')
    assert.equal(db.prepare('SELECT published_version_id FROM automations WHERE id=?').get(demoIds.automation).published_version_id, 'newer-version')
    db.exec("INSERT INTO workspaces(id,name) VALUES ('outro-workspace','Outro exemplo')")
    db.exec(`INSERT INTO channels(id,workspace_id,type,external_id,status)
      VALUES ('outro-canal','outro-workspace','telegram','999999','disconnected')`)
    db.exec(buildTelegramSeed('888888', 'outro-canal'))
    assert.deepEqual({ ...db.prepare("SELECT workspace_id,external_id,status FROM channels WHERE id='outro-canal'").get() }, {
      workspace_id: 'outro-workspace', external_id: '999999', status: 'disconnected',
    })
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close() }
})

test('seed rejeita IDs inválidos antes de gerar SQL', () => {
  assert.throws(() => buildTelegramSeed("123';DROP TABLE channels;--"), /ID numérico/)
  assert.throws(() => buildTelegramSeed('123456', "canal'"), /CHANNEL_ID/)
})

test('regras da demo identificam canal e propósito e o seed preserva nomes personalizados', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const migrations = new URL('../migrations/', import.meta.url)
    for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
      db.exec(await readFile(new URL(file, migrations), 'utf8'))
    }
    const seed = buildTelegramSeed('123456') + buildInstagramSeed('654321', 'demo')
    db.exec(seed)
    const nameOf = id => db.prepare('SELECT name FROM triggers WHERE id=?').get(id).name
    assert.equal(nameOf(demoIds.trigger), 'Telegram: pedido do link')
    assert.equal(nameOf(instagramIds.trigger), 'Instagram: pedido do link')
    assert.equal(db.prepare('SELECT provider FROM channels WHERE id=?').get(instagramIds.channel).provider, 'instagram_unified')
    db.prepare('UPDATE triggers SET name=? WHERE id=?').run('Minha regra Telegram', demoIds.trigger)
    db.prepare('UPDATE triggers SET name=? WHERE id=?').run('Minha regra Instagram', instagramIds.trigger)
    db.exec(seed)
    assert.equal(nameOf(demoIds.trigger), 'Minha regra Telegram')
    assert.equal(nameOf(instagramIds.trigger), 'Minha regra Instagram')
  } finally { db.close() }
})

test('migração dos nomes da demo altera somente os IDs conhecidos com nome legado no workspace demo', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const migrations = new URL('../migrations/', import.meta.url)
    const migrationFile = (await readdir(migrations)).find(file => file.endsWith('_demo_keyword_names.sql'))
    assert.ok(migrationFile, 'A migração dos nomes da demo deve existir.')
    for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql') && file !== migrationFile).sort()) {
      db.exec(await readFile(new URL(file, migrations), 'utf8'))
    }
    db.exec(buildTelegramSeed('123456') + buildInstagramSeed('654321', 'demo'))
    db.exec(`UPDATE triggers SET name='Pedido do link';
      INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config)
      SELECT 'regra-do-usuario',workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config
      FROM triggers WHERE id='w2-telegram-quero';`)
    const migration = await readFile(new URL(migrationFile, migrations), 'utf8')
    const otherData = () => ({
      keywords: db.prepare('SELECT * FROM keywords ORDER BY id').all(),
      automations: db.prepare('SELECT * FROM automations ORDER BY id').all(),
      connections: db.prepare('SELECT * FROM channels ORDER BY id').all(),
      // O trigger de auditoria do schema atualiza updated_at ao renomear.
      triggers: db.prepare('SELECT * FROM triggers ORDER BY id').all().map(({ name, ...row }) => {
        if (row.id === demoIds.trigger || row.id === instagramIds.trigger) delete row.updated_at
        return row
      }),
    })
    const beforeMigration = otherData()
    db.exec(migration)
    assert.deepEqual(otherData(), beforeMigration)
    const triggers = () => db.prepare('SELECT id,name FROM triggers ORDER BY id').all().map(row => ({ ...row }))
    assert.deepEqual(triggers(), [
      { id: 'regra-do-usuario', name: 'Pedido do link' },
      { id: instagramIds.trigger, name: 'Instagram: pedido do link' },
      { id: demoIds.trigger, name: 'Telegram: pedido do link' },
    ])
    db.prepare('UPDATE triggers SET name=? WHERE id=?').run('Nome personalizado', demoIds.trigger)
    db.exec(`INSERT INTO workspaces(id,name) VALUES ('outro-workspace','Outro workspace');
      INSERT INTO automations(id,workspace_id,name) VALUES ('outra-automacao','outro-workspace','Outra automação');
      DELETE FROM keywords WHERE id='w13-instagram-quero';`)
    db.prepare("UPDATE triggers SET name=?,workspace_id=?,automation_id='outra-automacao',channel_id=NULL WHERE id=?")
      .run('Pedido do link', 'outro-workspace', instagramIds.trigger)
    db.exec(migration)
    assert.deepEqual(triggers(), [
      { id: 'regra-do-usuario', name: 'Pedido do link' },
      { id: instagramIds.trigger, name: 'Pedido do link' },
      { id: demoIds.trigger, name: 'Nome personalizado' },
    ])
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close() }
})

test('parser .dev.vars mantém segredos em memória e rejeita aspas inválidas sem expor conteúdo', () => {
  assert.deepEqual(parseTelegramEnv(' # comentário\nexport A="texto\\nlinha"\nB=valor # comentário\nC=\'valor composto\'\nIGNORADO'), {
    A: 'texto\nlinha', B: 'valor', C: 'valor composto',
  })
  assert.throws(() => parseTelegramEnv('TOKEN="segredo\\x"'), { message: 'Aspas inválidas em engine/.dev.vars.' })
})

test('URL do webhook exige HTTPS público sem parâmetros nem destinos locais', () => {
  assert.equal(webhookUrl('https://demo.trycloudflare.com'), 'https://demo.trycloudflare.com/api/webhooks/telegram')
  assert.equal(webhookUrl('https://demo.trycloudflare.com/api/webhooks/telegram'), 'https://demo.trycloudflare.com/api/webhooks/telegram')
  for (const value of ['http://demo.trycloudflare.com', 'https://localhost', 'https://127.0.0.1', 'https://[::1]',
    'https://192.168.1.1', 'https://foo.localhost', 'https://worker.local', 'https://demo.trycloudflare.com/private',
    'https://user:password@demo.trycloudflare.com', 'https://demo.trycloudflare.com?token=x',
    'https://demo.trycloudflare.com#secret', 'https://demo.trycloudflare.com:9000']) {
    assert.throws(() => webhookUrl(value), /HTTPS pública/)
  }
})

test('registro valida bot dedicado antes da mutação, mantém pendências e confere URL persistida', async () => {
  const { fetcher, calls } = telegramMock({ getMe: { is_bot: true, username: expectedBotUsername }, setWebhook: true,
    getWebhookInfo: { url: 'https://demo.trycloudflare.com/api/webhooks/telegram', pending_update_count: 2 } })
  assert.deepEqual(await registerWebhook(env, 'https://demo.trycloudflare.com', fetcher), {
    bot: `@${expectedBotUsername}`, webhook: 'https://demo.trycloudflare.com/api/webhooks/telegram',
    pendingUpdates: 2, deliveryErrorReported: false,
  })
  assert.deepEqual(calls.map(call => call.method), ['getMe', 'setWebhook', 'getWebhookInfo'])
  assert.deepEqual(calls[1].body, { url: 'https://demo.trycloudflare.com/api/webhooks/telegram',
    secret_token: 'test-secret', allowed_updates: ['message', 'callback_query', 'my_chat_member'], max_connections: 1, drop_pending_updates: false })
})

test('credenciais inválidas e bot diferente impedem setWebhook', async () => {
  const { fetcher, calls } = telegramMock({ getMe: { is_bot: true, username: 'outro_bot' } })
  for (const invalid of [{ ...env, TELEGRAM_BOT_TOKEN: '' }, { ...env, TELEGRAM_WEBHOOK_SECRET: 'segredo inválido' },
    { ...env, TELEGRAM_CHANNEL_ID: '' }]) {
    await assert.rejects(registerWebhook(invalid, 'https://demo.trycloudflare.com', fetcher), /Configure/)
  }
  assert.equal(calls.length, 0)
  await assert.rejects(registerWebhook(env, 'https://demo.trycloudflare.com', fetcher), /webhook preservado/)
  assert.deepEqual(calls.map(call => call.method), ['getMe'])
})

test('registro falha se a leitura posterior divergir do webhook solicitado', async () => {
  const { fetcher } = telegramMock({ getMe: { is_bot: true, username: expectedBotUsername }, setWebhook: true,
    getWebhookInfo: { url: 'https://outro.example.com/api/webhooks/telegram' } })
  await assert.rejects(registerWebhook(env, 'https://demo.trycloudflare.com', fetcher), /webhook diferente/)
})

test('erros de rede, resposta e API não expõem token nem detalhes recebidos', async () => {
  for (const fetcher of [
    async () => { throw new Error(`https://api.telegram.org/bot${token}/sendMessage`) },
    async () => ({ ok: true, status: 200, json: async () => { throw new Error(token) } }),
    async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: token }) }),
  ]) {
    await assert.rejects(telegramCall(token, 'sendMessage', {}, fetcher), error => {
      assert.ok(!error.message.includes(token))
      assert.ok(!error.message.includes('https://'))
      return true
    })
  }
})
