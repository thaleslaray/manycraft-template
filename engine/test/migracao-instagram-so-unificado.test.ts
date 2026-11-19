import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'

const migration = (prefix: string) => env.TEST_MIGRATIONS.find(m => m.name.startsWith(prefix))!
const run = async (prefix: string) => { for (const query of migration(prefix).queries) await env.DB.prepare(query).run() }
const count = (sql: string, ...values: string[]) => env.DB.prepare(`SELECT count(*) AS n FROM ${sql}`).bind(...values).first<number>('n')

it('a migração apaga as conexões do Instagram antigo (e as legacy) e o que depende delas, e a regra do banco deixa de aceitar o provedor', async () => {
  // O banco do teste já está na última migração: a 0116 refeita devolve a regra antiga (que aceitava instagram_login) para semear o "antes".
  await run('0116')
  // Instagram 'legacy' só existe em linha anterior ao gatilho que preenche o padrão: tira o gatilho para semear e o devolve igual ao da 0116.
  const padrao = migration('0116').queries.find(q => q.includes('CREATE TRIGGER channels_provider_default'))!
  await env.DB.prepare('DROP TRIGGER channels_provider_default').run()
  const conexoes = [['ig-velho', 'instagram', 'instagram_login'], ['ig-legado', 'instagram', 'legacy'], ['ig-novo', 'instagram', 'instagram_unified'], ['tg-m', 'telegram', 'telegram_bot']]
  await env.DB.batch([
    env.DB.prepare("INSERT INTO workspaces (id,name) VALUES ('m','Migração')"),
    ...conexoes.map(([id, type, provider]) => env.DB.prepare('INSERT INTO channels (id,workspace_id,type,external_id,provider) VALUES (?,?,?,?,?)').bind(id, 'm', type, `ext-${id}`, provider)),
    env.DB.prepare("INSERT INTO contacts (id,workspace_id,first_name) VALUES ('c-m','m','Mariana')"),
    env.DB.prepare("INSERT INTO automations (id,workspace_id,name,draft_graph) VALUES ('auto-m','m','Automação','{\"nodes\":[],\"edges\":[]}')"),
    env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('ver-m','m','auto-m',1,'{\"nodes\":[],\"edges\":[]}')"),
    ...conexoes.flatMap(([id]) => [
      env.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES (?,'m','c-m',?,?,1)").bind(`cc-${id}`, id, `user-${id}`),
      env.DB.prepare("INSERT INTO conversations (id,workspace_id,contact_channel_id) VALUES (?,'m',?)").bind(`conv-${id}`, `cc-${id}`),
      env.DB.prepare("INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content) VALUES (?,'m',?,'in','contact','{\"text\":\"oi\"}')").bind(`msg-${id}`, `conv-${id}`),
      env.DB.prepare("INSERT INTO triggers (id,workspace_id,automation_id,channel_id,name,kind,status,config) VALUES (?,'m','auto-m',?,'Gatilho','keyword','active','{}')").bind(`trg-${id}`, id),
      env.DB.prepare("INSERT INTO inbound_media (inbound_id,workspace_id,channel_id,kind,status,updated_at) VALUES (?,'m',?,'image','pending',1)").bind(`in-${id}`, id),
      env.DB.prepare("INSERT INTO notification_topics (id,workspace_id,channel_id,name,created_at) VALUES (?,'m',?,'Ofertas',1)").bind(`top-${id}`, id),
      env.DB.prepare("INSERT INTO message_callbacks (workspace_id,contact_id,channel_id,url,method,expires_at) VALUES ('m','c-m',?,'https://exemplo.test','post',1)").bind(id),
      env.DB.prepare("INSERT INTO trigger_follow_ups (id,workspace_id,trigger_id,contact_id,channel_id,automation_id,created_at,due_at) VALUES (?,'m',?,'c-m',?,'auto-m',1,2)").bind(`fu-${id}`, `trg-${id}`, id),
      env.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id) VALUES (?,'m','c-m','ver-m',?)").bind(`run-${id}`, id),
      env.DB.prepare("INSERT INTO comment_effects (workspace_id,channel_id,comment_id,effect,run_id) VALUES ('m',?,'coment-1','private',?)").bind(id, `run-${id}`),
      env.DB.prepare("INSERT INTO workspace_members (id,workspace_id,user_id) VALUES (?,'m',?)").bind(`membro-${id}`, `user-${id}`),
      env.DB.prepare("INSERT INTO member_alert_settings (member_id,workspace_id,chat_id,chat_channel_id) VALUES (?,'m',?,?)").bind(`membro-${id}`, `chat-${id}`, id),
      env.DB.prepare("INSERT INTO alert_chat_codes (code,workspace_id,member_id,channel_id,expires_at) VALUES (?,'m',?,?,1)").bind(`cod-${id}`, `membro-${id}`, id),
    ]),
  ])
  await env.DB.prepare(padrao).run()
  expect(await env.DB.prepare("SELECT provider FROM channels WHERE id='ig-legado'").first('provider')).toBe('legacy')
  await run('0122')

  expect((await env.DB.prepare("SELECT id,provider FROM channels WHERE workspace_id='m' ORDER BY id").all()).results)
    .toEqual([{ id: 'ig-novo', provider: 'instagram_unified' }, { id: 'tg-m', provider: 'telegram_bot' }])
  for (const [table, column] of [['contact_channels', 'channel_id'], ['triggers', 'channel_id'], ['inbound_media', 'channel_id'], ['notification_topics', 'channel_id'], ['message_callbacks', 'channel_id'], ['trigger_follow_ups', 'channel_id'], ['flow_runs', 'channel_id'], ['comment_effects', 'channel_id'], ['alert_chat_codes', 'channel_id'], ['member_alert_settings', 'chat_channel_id']]) {
    expect(await count(`${table} WHERE ${column} IN ('ig-velho','ig-legado')`), table).toBe(0)
    expect(await count(`${table} WHERE ${column} IN ('ig-novo','tg-m')`), table).toBe(2)
  }
  // O aviso do membro fica (só perde o chat do canal apagado); o do canal que fica segue com o chat.
  expect((await env.DB.prepare("SELECT member_id,chat_id,chat_channel_id FROM member_alert_settings WHERE workspace_id='m' ORDER BY member_id").all()).results).toEqual([
    { member_id: 'membro-ig-legado', chat_id: null, chat_channel_id: null },
    { member_id: 'membro-ig-novo', chat_id: 'chat-ig-novo', chat_channel_id: 'ig-novo' },
    { member_id: 'membro-ig-velho', chat_id: null, chat_channel_id: null },
    { member_id: 'membro-tg-m', chat_id: 'chat-tg-m', chat_channel_id: 'tg-m' },
  ])
  expect(await count("conversations WHERE id IN ('conv-ig-velho','conv-ig-legado')")).toBe(0)
  expect(await count("messages WHERE id IN ('msg-ig-velho','msg-ig-legado')")).toBe(0)
  expect(await count("messages WHERE id IN ('msg-ig-novo','msg-tg-m')")).toBe(2)
  expect(await count("contacts WHERE id='c-m'")).toBe(1)

  const insert = (id: string, provider?: string) => env.DB.prepare(`INSERT INTO channels (id,workspace_id,type,external_id${provider ? ',provider' : ''}) VALUES (?,?,?,?${provider ? ',?' : ''})`)
    .bind(...[id, 'm', 'instagram', `ext-${id}`, ...provider ? [provider] : []]).run()
  await expect(insert('ig-recusado', 'instagram_login')).rejects.toThrow(/CHECK constraint|provider_kind_mismatch/)
  await insert('ig-padrao')
  expect(await env.DB.prepare("SELECT provider FROM channels WHERE id='ig-padrao'").first('provider')).toBe('instagram_unified')
  await expect(env.DB.prepare("UPDATE channels SET provider='instagram_login' WHERE id='ig-novo'").run()).rejects.toThrow(/CHECK constraint|provider_kind_mismatch|immutable/)
})
