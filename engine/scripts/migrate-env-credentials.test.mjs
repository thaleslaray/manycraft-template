import test from 'node:test'
import assert from 'node:assert/strict'
import { parseVars, plan, updateSql } from './migrate-env-credentials.mjs'

const old = parseVars(`# comentário
TELEGRAM_BOT_TOKEN=111:abc
TELEGRAM_WEBHOOK_SECRET="seg-antigo"
TELEGRAM_CHANNEL_ID=demo-telegram
WHATSAPP_ACCESS_TOKEN=EAAG
WHATSAPP_PHONE_NUMBER_ID=5550001
META_APP_SECRET=meta-secret
META_VERIFY_TOKEN=verify
IG_ACCESS_TOKEN=IGQ
IG_ACCOUNT_ID=17841
IG_APP_SECRET=ig-secret
`)

test('lê o formato .dev.vars ignorando comentários e aspas', () => {
  assert.equal(old.TELEGRAM_WEBHOOK_SECRET, 'seg-antigo')
  assert.equal(old['# comentário'], undefined)
})
test('cada grupo de variáveis vira as credenciais da conexão certa e o segredo do webhook antigo é mantido', () => {
  const [tg, wa, ig] = plan(old)
  assert.deepEqual(tg, { label: 'telegram', where: { id: 'demo-telegram', type: 'telegram' }, credentials: { botToken: '111:abc', webhookSecret: 'seg-antigo' } })
  assert.equal(wa.where.externalId, '5550001')
  assert.deepEqual({ ...wa.credentials, webhookSecret: undefined }, { accessToken: 'EAAG', phoneNumberId: '5550001', appSecret: 'meta-secret', verifyToken: 'verify', webhookSecret: undefined })
  assert.equal(ig.where.externalId, '17841')
  assert.equal(ig.credentials.appSecret, 'ig-secret')
})
test('grupo incompleto não gera nada', () => {
  assert.deepEqual(plan({ TELEGRAM_BOT_TOKEN: 'x' }), [])
})
test('Meta: o token de verificação antigo é também o segredo do webhook (a Meta compara com ele)', () => {
  const [, wa, ig] = plan(old)
  assert.equal(wa.credentials.webhookSecret, 'verify')
  assert.equal(ig.credentials.webhookSecret, 'verify')
  const [, wa2] = plan({ ...old, META_VERIFY_TOKEN: '' })
  assert.ok(wa2.credentials.webhookSecret.length >= 32)
})
test('a migração não declara webhook registrado (nada foi registrado por ela)', () => {
  const sql = updateSql({ id: 'c1' }, { ciphertext: 'x', iv: 'y', keyVersion: 1 }, 'h', 'whatsapp', 1)
  assert.doesNotMatch(sql, /webhook_registered_at/)
  assert.match(sql, /webhook_mode='manual'/)
  assert.match(updateSql({ id: 'c1' }, { ciphertext: 'x', iv: 'y', keyVersion: 1 }, 'h', 'telegram', 1), /webhook_mode='auto'/)
})
