import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadTelegramEnv, expectedBotUsername } from './telegram-webhook.mjs'

export const demoIds = {
  workspace: 'demo-workspace', channel: 'demo-telegram', automation: 'w2-telegram-demo',
  version: 'w2-telegram-demo-v1', trigger: 'w2-telegram-quero', keyword: 'w2-telegram-quero', tag: 'w2-lead',
  user: 'demo-user', member: 'demo-owner',
}
export const demoGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'offer', type: 'message', position: { x: 380, y: 0 }, config: {
      blocks: [
        { kind: 'text', text: 'Seu pedido chegou! Toque abaixo para receber o link da demonstração.' },
        { kind: 'button', id: 'quero-link', label: 'Quero o link', action: { type: 'go_to_node' } },
      ], click_timeout: { value: 15, unit: 'minutes' },
    } },
    { id: 'delay', type: 'smart_delay', position: { x: 760, y: 0 }, config: { duration: { value: 1, unit: 'minutes' } } },
    { id: 'delivery', type: 'message', position: { x: 1140, y: 0 }, config: {
      blocks: [{ kind: 'text', text: 'Aqui está o link de demonstração: https://example.com/ — seu interesse foi registrado.' }],
    } },
    { id: 'lead', type: 'action', position: { x: 1520, y: 0 }, config: { actions: [{ type: 'add_tag', tag_id: demoIds.tag }] } },
  ],
  edges: [
    { from: 'trigger', port: 'next', to: 'offer' },
    { from: 'offer', port: 'btn:quero-link', to: 'delay' },
    { from: 'delay', port: 'next', to: 'delivery' },
    { from: 'delivery', port: 'next', to: 'lead' },
  ],
}

const sqlValue = value => `'${String(value).replaceAll("'", "''")}'`

export function buildTelegramSeed(botId, channelId = demoIds.channel) {
  if (!/^\d+$/.test(botId ?? '')) throw new Error('Informe um ID numérico do bot ou configure TELEGRAM_BOT_TOKEN.')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(channelId)) throw new Error('TELEGRAM_CHANNEL_ID inválido.')
  const q = sqlValue
  const id = demoIds
  const graph = q(JSON.stringify(demoGraph))
  // Fixed version IDs are immutable: rerunning the seed never replaces a
  // published snapshot or downgrades a subsequently published user version.
  return `PRAGMA foreign_keys = ON;
INSERT OR IGNORE INTO workspaces(id,name,timezone) VALUES (${q(id.workspace)},'Demonstração local do motor','America/Sao_Paulo');
INSERT OR IGNORE INTO "user"(id,name,email,emailVerified,createdAt,updatedAt)
VALUES (${q(id.user)},'Lia Exemplo','lia@example.test',1,datetime('now'),datetime('now'));
INSERT OR IGNORE INTO workspace_members(id,workspace_id,user_id,role)
VALUES (${q(id.member)},${q(id.workspace)},${q(id.user)},'owner');
INSERT INTO channels(id,workspace_id,type,external_id,status,display_name)
VALUES (${q(channelId)},${q(id.workspace)},'telegram',${q(botId)},'connected',${q(`@${expectedBotUsername}`)})
ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id,status='connected',display_name=excluded.display_name
WHERE channels.workspace_id=excluded.workspace_id AND channels.type='telegram';
INSERT OR IGNORE INTO tags(id,workspace_id,name) VALUES (${q(id.tag)},${q(id.workspace)},'lead');
INSERT OR IGNORE INTO automations(id,workspace_id,name,draft_graph)
VALUES (${q(id.automation)},${q(id.workspace)},'Telegram: pedido e entrega do link',${graph});
INSERT OR IGNORE INTO automation_versions(id,workspace_id,automation_id,version,graph)
VALUES (${q(id.version)},${q(id.workspace)},${q(id.automation)},1,${graph});
UPDATE automations SET published_version_id=${q(id.version)},status='live',has_unpublished_changes=0
WHERE id=${q(id.automation)} AND workspace_id=${q(id.workspace)}
AND (published_version_id IS NULL OR published_version_id=${q(id.version)});
INSERT OR IGNORE INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config)
VALUES (${q(id.trigger)},${q(id.workspace)},${q(id.automation)},${q(channelId)},'Telegram: pedido do link','keyword','active','every_time','{"node_id":"trigger"}');
INSERT OR IGNORE INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority)
VALUES (${q(id.keyword)},${q(id.workspace)},${q(id.trigger)},'is','["quero"]','live',0);
`
}

export const instagramIds = {
  channel: 'demo-instagram', automation: 'w13-instagram-demo', version: 'w13-instagram-v1',
  trigger: 'w13-instagram-quero', keyword: 'w13-instagram-quero',
}

/** Canal e demonstração do Instagram; mesmo fluxo do Telegram, entrando pela DM. */
export function buildInstagramSeed(accountId, handle) {
  if (!/^\d+$/.test(accountId ?? '')) throw new Error('IG_ACCOUNT_ID inválido.')
  const q = sqlValue
  const id = { ...demoIds, ...instagramIds }
  const graph = q(JSON.stringify(demoGraph))
  return `INSERT INTO channels(id,workspace_id,type,provider,external_id,status,display_name)
VALUES (${q(id.channel)},${q(id.workspace)},'instagram','instagram_unified',${q(accountId)},'connected',${q(handle ? `@${handle}` : 'Instagram')})
ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id,status='connected'
WHERE channels.workspace_id=excluded.workspace_id AND channels.type='instagram';
INSERT OR IGNORE INTO automations(id,workspace_id,name,draft_graph)
VALUES (${q(id.automation)},${q(id.workspace)},'Instagram: pedido e entrega do link',${graph});
INSERT OR IGNORE INTO automation_versions(id,workspace_id,automation_id,version,graph)
VALUES (${q(id.version)},${q(id.workspace)},${q(id.automation)},1,${graph});
UPDATE automations SET published_version_id=${q(id.version)},status='live',has_unpublished_changes=0
WHERE id=${q(id.automation)} AND workspace_id=${q(id.workspace)}
AND (published_version_id IS NULL OR published_version_id=${q(id.version)});
INSERT OR IGNORE INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config)
VALUES (${q(id.trigger)},${q(id.workspace)},${q(id.automation)},${q(id.channel)},'Instagram: pedido do link','keyword','active','every_time','{"node_id":"trigger"}');
INSERT OR IGNORE INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority)
VALUES (${q(id.keyword)},${q(id.workspace)},${q(id.trigger)},'is','["quero"]','live',0);
`
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('Uso: npm run telegram:seed\n'
      + 'Cria proprietário fictício sem senha, canal e demonstração publicada apenas no D1 local (--env dev).\n'
      + 'Requer TELEGRAM_BOT_TOKEN e TELEGRAM_CHANNEL_ID em engine/.dev.vars; não chama Telegram.\n'
      + 'Com IG_ACCOUNT_ID (e opcional IG_USERNAME) também cria canal e demonstração do Instagram.\n'
      + 'Prévia sem credenciais: npm run telegram:seed -- --sql --bot-id 123456789\n'
      + 'Execute npm run db:migrate antes. Reexecução preserva versões publicadas.')
    return
  }
  let botId
  let sqlOnly = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sql') sqlOnly = true
    else if (args[i] === '--bot-id' && args[i + 1]) botId = args[++i]
    else throw new Error('Argumentos inválidos. Consulte --help.')
  }
  const env = await loadTelegramEnv()
  botId ??= env.TELEGRAM_BOT_TOKEN?.match(/^(\d+):[A-Za-z0-9_-]+$/)?.[1]
  if (!sqlOnly && !env.TELEGRAM_CHANNEL_ID) throw new Error('Configure TELEGRAM_CHANNEL_ID em engine/.dev.vars.')
  let sql = buildTelegramSeed(botId, env.TELEGRAM_CHANNEL_ID ?? demoIds.channel)
  // Instagram entra só quando a conta está configurada; sem ela o seed segue só com Telegram.
  if (env.IG_ACCOUNT_ID) sql += buildInstagramSeed(env.IG_ACCOUNT_ID, env.IG_USERNAME)
  if (sqlOnly) { console.log(sql); return }
  const directory = await mkdtemp(join(tmpdir(), 'replica-telegram-'))
  try {
    const filename = join(directory, 'seed.sql')
    await writeFile(filename, sql, { mode: 0o600 })
    const engine = fileURLToPath(new URL('../', import.meta.url))
    const cli = join(engine, 'node_modules/wrangler/bin/wrangler.js')
    const result = spawnSync(process.execPath, [cli, 'd1', 'execute', 'DB', '--local', '--env', 'dev', '--file', filename], {
      cwd: engine, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    })
    if (result.error || result.status !== 0) throw new Error('Falha no seed D1 local. Verifique as migrações e a instalação do Wrangler.')
    console.log(JSON.stringify({ seeded: true, localOnly: true, ...demoIds, channel: env.TELEGRAM_CHANNEL_ID }, null, 2))
    console.log('Envie "quero" ao bot, toque em "Quero o link" e aguarde 1 minuto para a segunda mensagem e tag lead.')
  } finally { await rm(directory, { recursive: true, force: true }) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
