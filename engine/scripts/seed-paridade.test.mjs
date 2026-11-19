import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { before, test } from 'node:test'
import { buildInstagramSeed, buildTelegramSeed, demoIds } from './seed-telegram.mjs'

let db
before(async () => {
  db = new DatabaseSync(':memory:')
  const migrations = new URL('../migrations/', import.meta.url)
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) db.exec(await readFile(new URL(file, migrations), 'utf8'))
  db.exec(await readFile(new URL('./seed.sql', import.meta.url), 'utf8'))
  db.exec(buildTelegramSeed('123456789', demoIds.channel) + buildInstagramSeed('17841400000000000', 'demo_instagram'))
  const r = spawnSync(process.execPath, [new URL('./seed-paridade.mjs', import.meta.url).pathname, '--sql'], { env: { ...process.env, DEV_STATE_PATH: '/tmp/seed-paridade-teste-nao-usado' }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  assert.equal(r.status, 0, r.stderr)
  db.exec(r.stdout)
})

const um = (sql, ...p) => db.prepare(sql).get(...p)
const todos = (sql, ...p) => db.prepare(sql).all(...p)

test('as contagens de contatos por tag exibidas batem com as linhas marcadas', () => {
  const tags = todos(`SELECT t.name, t.contact_count AS exibido, (SELECT count(*) FROM contact_tags ct WHERE ct.tag_id = t.id) AS real FROM tags t`)
  assert.ok(tags.length >= 12)
  for (const t of tags) assert.equal(t.exibido, t.real, `tag ${t.name}`)
  assert.ok(Math.max(...tags.map(t => t.exibido)) >= 3000, 'a maior tag tem milhares de contatos')
})

test('a conta tem milhares de contatos, com nomes longos', () => {
  assert.ok(um('SELECT count(*) AS n FROM contacts').n >= 4000)
  assert.ok(um(`SELECT max(length(first_name || ' ' || last_name)) AS n FROM contacts`).n >= 20)
})

test('toda foto do seed é um PNG válido pequeno, nenhuma silhueta SVG', () => {
  const fotos = [
    ...todos('SELECT profile_pic_url AS f FROM contacts WHERE profile_pic_url IS NOT NULL'),
    ...todos('SELECT image AS f FROM "user" WHERE image IS NOT NULL'),
  ].map(r => r.f)
  assert.ok(fotos.length >= 30, 'contatos e equipe têm fotos')
  for (const f of fotos) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(f)
    assert.ok(m, 'a foto é PNG embutido')
    const b = Buffer.from(m[1], 'base64')
    assert.ok(b.length < 20_000)
    assert.deepEqual([...b.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(b.subarray(12, 16).toString(), 'IHDR')
    assert.ok(b.readUInt32BE(16) >= 64 && b.readUInt32BE(20) >= 64)
  }
  assert.ok(um(`SELECT size FROM media_objects WHERE content_type='image/png'`).size > 0)
})

test('o histórico de transmissões tem centenas de linhas e cada contagem de envio bate com os destinatários', () => {
  assert.ok(um(`SELECT count(*) AS n FROM broadcasts`).n >= 100)
  const ruins = todos(`SELECT b.name FROM broadcasts b WHERE b.status='sent' AND b.sent_count != (SELECT count(*) FROM broadcast_recipients r WHERE r.broadcast_id=b.id)`)
  assert.deepEqual(ruins, [])
})

test('as prévias de mensagem da caixa de entrada têm comprimento de conversa real', () => {
  const t = todos(`SELECT json_extract(content,'$.text') AS t FROM messages WHERE direction='in'`).map(r => r.t.length)
  assert.equal(um('SELECT count(*) AS n FROM conversations').n, 14)
  assert.ok(Math.max(...t) >= 60)
})

test('cada conexão tem contatos próprios (totais por conexão diferentes)', () => {
  const por = todos(`SELECT channel_id, count(*) AS n FROM contact_channels GROUP BY channel_id`)
  assert.ok(por.length >= 3)
  assert.ok(new Set(por.map(p => p.n)).size >= 3)
})

test('toda transmissão do seed grava o fluxo (abre no mapa, não no formulário antigo)', () => {
  assert.deepEqual(todos(`SELECT name FROM broadcasts WHERE flow IS NULL`), [])
  const b = um(`SELECT flow, content FROM broadcasts WHERE id='bc-r0'`)
  const passo = JSON.parse(b.flow).nodes.find(n => n.id === 'broadcast-message')
  assert.equal(passo.config.blocks[0].text, b.content)
})

test('as listas de transmissões passam de 5 em Agendado, Rascunhos e Histórico (aparece "Veja todas")', () => {
  for (const status of ['scheduled', 'draft', 'sent']) assert.ok(um(`SELECT count(*) AS n FROM broadcasts WHERE status=?`, status).n > 5, status)
})

test('Configurações tem a forma de dados do original: modelos, aplicativos, chave de API', () => {
  assert.equal(um('SELECT count(*) AS n FROM template_installs').n, 17)
  assert.equal(um('SELECT count(*) AS n FROM installed_apps').n, 8)
  assert.equal(um('SELECT count(*) AS n FROM api_keys WHERE revoked_at IS NULL').n, 1)
})

test('tags e campos têm muitas pastas e dezenas de itens', () => {
  const pastasTags = um(`SELECT count(*) AS n FROM settings_folders WHERE kind='tags'`).n
  assert.ok(pastasTags >= 17 && pastasTags <= 24, 'até seis linhas de pastas de tags (grade de 4)')
  assert.ok(um(`SELECT count(*) AS n FROM settings_folders WHERE kind='fields'`).n >= 24)
  assert.ok(um('SELECT count(*) AS n FROM tags').n >= 36)
  assert.ok(um('SELECT count(*) AS n FROM custom_fields').n >= 24)
  const vazias = todos(`SELECT f.name FROM settings_folders f WHERE f.kind='tags' AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.folder_id=f.id)`)
  assert.deepEqual(vazias, [], 'nenhuma pasta de tags vazia')
})

test('há mais de 20 sequências', () => {
  assert.ok(um('SELECT count(*) AS n FROM sequences').n >= 22)
})

test('a equipe tem foto em Proprietário, Administradores, Editor e Agente', () => {
  for (const papel of ['owner', 'administrator', 'editor', 'livechat_agent']) {
    const sem = todos(`SELECT u.name FROM workspace_members m JOIN "user" u ON u.id=m.user_id WHERE m.role=? AND u.image IS NULL`, papel)
    assert.deepEqual(sem, [], papel)
    assert.ok(um('SELECT count(*) AS n FROM workspace_members WHERE role=?', papel).n >= 1, papel)
  }
})

test('a maioria dos contatos da primeira página tem foto', () => {
  const pagina = todos(`SELECT profile_pic_url AS f FROM contacts ORDER BY last_interaction_at DESC LIMIT 50`)
  assert.ok(pagina.filter(c => c.f).length > 25)
})
