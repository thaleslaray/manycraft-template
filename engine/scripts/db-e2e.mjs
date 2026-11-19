#!/usr/bin/env node
// Monta um banco local novo para as jornadas (migrações + seed.sql + Telegram de demonstração) numa pasta à parte.
// Uso: DEV_STATE_PATH=/pasta/estado npm run db:e2e   (nunca toca engine/.wrangler/state; sem DEV_STATE_PATH ele recusa)
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildInstagramSeed, buildTelegramSeed, demoIds } from './seed-telegram.mjs'
import { estadoDoAmbiente, wranglerLocal } from './estado-local.mjs'

const estado = estadoDoAmbiente('com a pasta do estado novo (ex.: DEV_STATE_PATH=/tmp/estado-e2e npm run db:e2e)')
const wrangler = (...args) => wranglerLocal(estado, ...args)

console.log(`estado em ${estado}`)
wrangler('d1', 'migrations', 'apply', 'DB')
wrangler('d1', 'execute', 'DB', '--file', 'scripts/seed.sql')
// Canais "conectados" com ids inventados (as jornadas sobem o Telegram falso por conta própria). Com dois canais o editor pergunta
// "Por qual canal vai esta mensagem?", que algumas jornadas esperam.
const dir = await mkdtemp(join(tmpdir(), 'replica-db-e2e-'))
try {
  const arquivo = join(dir, 'telegram.sql')
  await writeFile(arquivo, buildTelegramSeed('123456789', demoIds.channel) + buildInstagramSeed('17841400000000000', 'demo_instagram'), { mode: 0o600 })
  wrangler('d1', 'execute', 'DB', '--file', arquivo)
} finally { await rm(dir, { recursive: true, force: true }) }
console.log('banco das jornadas pronto. Suba o motor com o mesmo DEV_STATE_PATH (ver docs/agents/testes.md).')
