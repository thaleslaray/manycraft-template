// Peças comuns dos scripts que gravam num banco local à parte (db-e2e, seed-paridade): a guarda do DEV_STATE_PATH
// e a chamada do wrangler contra esse estado. Nunca toca engine/.wrangler/state.
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const engine = fileURLToPath(new URL('../', import.meta.url))

/** Pasta do estado vinda de DEV_STATE_PATH; sai com erro se faltar ou se for o banco de desenvolvimento. */
export function estadoDoAmbiente(dica) {
  const estado = process.env.DEV_STATE_PATH ? resolve(process.env.DEV_STATE_PATH) : null
  if (!estado) { console.error(`Defina DEV_STATE_PATH ${dica}.`); process.exit(2) }
  if (estado === resolve(engine, '.wrangler/state')) { console.error('DEV_STATE_PATH aponta para o banco de desenvolvimento; use outra pasta.'); process.exit(2) }
  return estado
}

/** Roda `wrangler <args> --local --env dev --persist-to <estado>`; em falha mostra o fim da saída (sem as molduras do wrangler) e sai. */
export function wranglerLocal(estado, ...args) {
  const r = spawnSync(process.execPath, [join(engine, 'node_modules/wrangler/bin/wrangler.js'), ...args, '--local', '--env', 'dev', '--persist-to', estado], {
    cwd: engine, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })
  if (r.status !== 0) { console.error(((r.stderr || '') + (r.stdout || '')).split('\n').filter(l => l.trim() && !/^[│├└┌]/.test(l)).slice(-12).join('\n')); process.exit(1) }
}
