import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, fixtureCookie, seedAuth } from './auth-helpers'
import { graph } from './fixtures'

let cookie = ''
beforeEach(async () => { await seedAuth(); cookie = await fixtureCookie() })
const call = (path: string, method = 'GET', body?: unknown) => authenticatedRequest(path, 'a', { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }, cookie)
const asRole = (role: string) => env.DB.prepare("UPDATE workspace_members SET role=? WHERE user_id='user-a' AND workspace_id='a'").bind(role).run()

it('dono trava a automação; editor só lê e não salva, renomeia nem exclui; destravar libera', async () => {
  expect((await call('automations/auto-a/lock', 'POST', { locked: true })).status).toBe(200)
  expect(await (await call('automations/auto-a')).json()).toMatchObject({ automation: { locked: true } })
  await asRole('editor')
  expect((await call('automations/auto-a')).status).toBe(200)
  for (const [path, method, body] of [['automations/auto-a/draft', 'PUT', { graph }], ['automations/auto-a', 'PATCH', { name: 'Outro' }],
    ['automations/auto-a/trash', 'POST', undefined], ['automations/auto-a/lock', 'POST', { locked: false }]] as const) {
    expect((await call(path, method, body)).status, `${method} ${path}`).toBe(403)
  }
  await asRole('administrator')
  expect((await call('automations/auto-a/lock', 'POST', { locked: false })).status).toBe(200)
  await asRole('editor')
  expect((await call('automations/auto-a', 'PATCH', { name: 'Outro' })).status).toBe(200)
})

it('permissões por automação: só as ações escolhidas ficam travadas para o editor', async () => {
  const r = await call('automations/auto-a/lock', 'POST', { locked: true, actions: ['delete', 'purge', 'share'] })
  expect(await r.json()).toMatchObject({ locked: true, actions: ['delete', 'purge', 'share'] })
  await asRole('editor')
  expect((await call('automations/auto-a', 'PATCH', { name: 'Pode renomear' })).status).toBe(200)
  expect((await call('automations/auto-a/trash', 'POST')).status).toBe(403)
  expect((await call('automations/auto-a/share', 'POST', {})).status).toBe(403)
  expect((await call('automations/auto-a', 'DELETE')).status).toBe(403)
  await asRole('owner')
  await call('automations/auto-a/lock', 'POST', { locked: true, actions: ['move'] })
  await asRole('editor')
  expect((await call('automations/auto-a', 'PATCH', { folder_id: null })).status).toBe(403)
  expect((await call('automations/auto-a', 'PATCH', { name: 'De novo' })).status).toBe(200)
})

it('B2: com trava de mover, nome e pasta juntos também dão 403 e a pasta não muda', async () => {
  await env.DB.prepare("INSERT INTO folders(id,workspace_id,name) VALUES ('f-lock','a','Destino')").run()
  await call('automations/auto-a/lock', 'POST', { locked: true, actions: ['move'] })
  await asRole('editor')
  expect((await call('automations/auto-a', 'PATCH', { name: 'Mix', folder_id: 'f-lock' })).status).toBe(403)
  expect(await env.DB.prepare("SELECT folder_id,name FROM automations WHERE id='auto-a'").first()).toMatchObject({ folder_id: null })
  expect((await call('automations/auto-a', 'PATCH', { name: 'Só nome' })).status).toBe(200)
})

// B1 (auditoria de segurança): a trava vale para toda rota que altera a automação, não só para o prefixo /automations/:id.
const draftOf = (id = 'auto-a') => env.DB.prepare('SELECT draft_graph FROM automations WHERE id=?').bind(id).first<string>('draft_graph')
const one = (sql: string, ...values: unknown[]) => env.DB.prepare(sql).bind(...values).first<Record<string, unknown>>()
async function prepared(actions?: string[]) {
  await env.DB.prepare("INSERT INTO automations (id,workspace_id,name,draft_graph) VALUES ('auto-a2','a','Outra',?)").bind(JSON.stringify(graph)).run()
  await call('automations/auto-a/publish', 'POST')
  await call('automations/auto-a2/publish', 'POST')
  await call('automations/auto-a/lock', 'POST', actions ? { locked: true, actions } : { locked: true })
  await asRole('editor')
}
const rule = { name: 'Receber material', channel: 'instagram', automation_id: 'auto-a', active: true, rules: [{ condition: 'equals', words: ['Quero'] }] }

it('B1 gatilhos: substituir, status de inscrição e follow-up de gatilho de automação trancada dão 403 e nada muda', async () => {
  await prepared()
  const before = await one("SELECT automation_id,config FROM triggers WHERE id='trg-a'")
  expect((await call('triggers/trg-a/replace', 'POST', { automation_id: 'auto-a2' })).status).toBe(403)
  expect((await call('triggers/trg-a/opt-in-status', 'PUT', { opt_in_status: 'do_not_send' })).status).toBe(403)
  expect((await call('triggers/trg-a/follow-up', 'PUT', { follow_up: { after_minutes: 5, automation_id: 'auto-a2' } })).status).toBe(403)
  expect(await one("SELECT automation_id,config FROM triggers WHERE id='trg-a'")).toEqual(before)
  // O destino também é alterado (ganha um gatilho): apontar um gatilho livre para a automação trancada é bloqueado.
  await env.DB.prepare("INSERT INTO triggers (id,workspace_id,automation_id,channel_id,name,kind,status,config) VALUES ('trg-a2','a','auto-a2','ch-a','Livre','keyword','active','{}')").run()
  expect((await call('triggers/trg-a2/replace', 'POST', { automation_id: 'auto-a' })).status).toBe(403)
  expect((await one("SELECT automation_id FROM triggers WHERE id='trg-a2'"))?.automation_id).toBe('auto-a2')
})

it('B1 palavras-chave: criar, editar, ligar/desligar e apagar regra de automação trancada dão 403 e nada muda', async () => {
  await prepared()
  const rows = () => env.DB.prepare("SELECT k.id,k.status,t.automation_id,t.name FROM keywords k JOIN triggers t ON t.id=k.trigger_id ORDER BY k.id").all().then(r => r.results)
  const before = await rows()
  expect((await call('keywords', 'POST', rule)).status).toBe(403)
  expect((await call('keywords/key-a', 'PATCH', { active: false })).status).toBe(403)
  expect((await call('keywords/key-a', 'PATCH', { ...rule, name: 'Outro nome' })).status).toBe(403)
  expect((await call('keywords/key-a', 'DELETE')).status).toBe(403)
  expect((await call('keywords/automation', 'POST', { name: 'Nova', channel: 'instagram', rules: rule.rules, keyword_id: 'key-a' })).status).toBe(403)
  expect(await rows()).toEqual(before)
  // Regra de uma automação livre não pode ser apontada para a trancada.
  await env.DB.batch([env.DB.prepare("INSERT INTO triggers (id,workspace_id,automation_id,channel_id,name,kind,status,config) VALUES ('trg-a2','a','auto-a2','ch-a','Livre','keyword','active','{}')"),
    env.DB.prepare("INSERT INTO keywords (id,workspace_id,trigger_id,rule,words,priority) VALUES ('key-a2','a','trg-a2','contains','[\"oi\"]',2)")])
  expect((await call('keywords/key-a2', 'PATCH', { ...rule, name: 'Livre' })).status).toBe(403)
  expect((await one("SELECT automation_id FROM triggers WHERE id='trg-a2'"))?.automation_id).toBe('auto-a2')
  expect((await call('keywords/key-a2', 'PATCH', { active: false })).status).toBe(200)
})

it('B1 importação da ManyChat: reimportar sobre automação trancada dá 403 e o rascunho não muda', async () => {
  const clipboard = (await import('./fixtures/manychat/cond_goto_template.json')).default
  await asRole('owner')
  const first = await (await call('imports/manychat', 'POST', clipboard)).json() as { automation: { id: string } }
  await call(`automations/${first.automation.id}/lock`, 'POST', { locked: true })
  const before = await draftOf(first.automation.id)
  await asRole('editor')
  expect((await call('imports/manychat', 'POST', { ...clipboard, name: 'Outro nome' })).status).toBe(403)
  expect(await draftOf(first.automation.id)).toBe(before)
  await asRole('administrator')
  expect((await call('imports/manychat', 'POST', clipboard)).status).toBe(200)
})

it('B1 conexões básicas: ligar uma automação trancada, ou trocar a que está ligada, dá 403 e nada muda', async () => {
  await prepared()
  const put = (kind: string, automation_id: string) => call(`basic/ch-a/${kind}`, 'PUT', { automation_id, enabled: false, repeat_mode: 'every_time', dm_only: false })
  const count = () => one("SELECT count(*) n FROM triggers WHERE kind IN ('default_reply','welcome_message','external_trigger')")
  const before = await count()
  expect((await put('default_reply', 'auto-a')).status).toBe(403)
  expect(await count()).toEqual(before)
  // Já ligada à automação trancada (feito pelo dono): o editor não troca para outra.
  await asRole('owner')
  await call('automations/auto-a/lock', 'POST', { locked: false })
  expect((await put('welcome_message', 'auto-a')).status).toBe(200)
  await call('automations/auto-a/lock', 'POST', { locked: true })
  await asRole('editor')
  expect((await put('welcome_message', 'auto-a2')).status).toBe(403)
  expect((await one("SELECT automation_id FROM triggers WHERE kind='welcome_message'"))?.automation_id).toBe('auto-a')
  // O fluxo padrão de descadastro troca a confirmação ligada: com ela numa automação trancada, só dono e administrador.
  await asRole('owner')
  await call('automations/auto-a/lock', 'POST', { locked: false })
  expect((await put('system_opt_out', 'auto-a')).status).toBe(200)
  await call('automations/auto-a/lock', 'POST', { locked: true })
  await asRole('editor')
  expect((await call('basic/ch-a/system_opt_out/default', 'POST')).status).toBe(403)
  expect((await one("SELECT automation_id FROM triggers WHERE json_extract(config,'$.system_kind')='system_opt_out'"))?.automation_id).toBe('auto-a')
  await asRole('administrator')
  expect((await call('basic/ch-a/system_opt_out/default', 'POST')).status).toBe(201)
})

it('B1 excluir pasta movendo os itens: só a ação "mover" trancada bloqueia', async () => {
  await env.DB.prepare("INSERT INTO folders(id,workspace_id,name) VALUES ('f-lock','a','Pasta')").run()
  await env.DB.prepare("UPDATE automations SET folder_id='f-lock' WHERE id='auto-a'").run()
  await call('automations/auto-a/lock', 'POST', { locked: true, actions: ['move'] })
  await asRole('editor')
  expect((await call('folders/f-lock?move_items=1', 'DELETE')).status).toBe(403)
  expect((await one("SELECT folder_id FROM automations WHERE id='auto-a'"))?.folder_id).toBe('f-lock')
  expect(await one("SELECT id FROM folders WHERE id='f-lock'")).toBeTruthy()
  await asRole('owner')
  await call('automations/auto-a/lock', 'POST', { locked: true, actions: ['edit'] })
  await asRole('editor')
  expect((await call('folders/f-lock?move_items=1', 'DELETE')).status).toBe(200)
  expect((await one("SELECT folder_id FROM automations WHERE id='auto-a'"))?.folder_id).toBeNull()
})

it('B1 administrador continua passando pelas mesmas rotas, mesmo com a automação trancada', async () => {
  await prepared()
  await asRole('administrator')
  expect((await call('triggers/trg-a/opt-in-status', 'PUT', { opt_in_status: 'do_not_send' })).status).toBe(200)
  expect((await call('keywords/key-a', 'PATCH', { active: false })).status).toBe(200)
  expect((await call('keywords/key-a', 'DELETE')).status).toBe(200)
  expect((await call('triggers/trg-a/replace', 'POST', { automation_id: 'auto-a2' })).status).toBe(200)
})
