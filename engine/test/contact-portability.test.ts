import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { initialize } from '../src/email-channel/store'
import { receiveReply } from '../src/email-channel/receive'

beforeEach(seedAuth)
const request = (path: string, body?: unknown) => authenticatedRequest(path, 'a', body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }, undefined, { ...env, FLOW_RUN: undefined })
async function secondary(kind = 'telegram', provider = 'telegram_bot') {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name,last_name,email,phone) VALUES ('secondary','a','Nome secundário','Santos','secondary@example.test','5581999999999')"),
    env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,display_name) VALUES ('secondary-channel','a',?,?, 'secondary-account','Conta secundária')").bind(kind, provider),
    env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in,identity_kind,address_kind,phone_e164) VALUES ('secondary-identity','a','secondary','secondary-channel',?,1,?,?,?)")
      .bind(kind === 'whatsapp' ? 'BR.secondary' : 'secondary-user', kind === 'whatsapp' ? 'bsuid' : 'provider_id', kind === 'whatsapp' ? 'bsuid' : null, kind === 'whatsapp' ? '+5581999999999' : null),
    env.DB.prepare("INSERT INTO conversations(id,workspace_id,contact_channel_id) VALUES ('secondary-conversation','a','secondary-identity')"),
    env.DB.prepare(`INSERT INTO messages(id,workspace_id,conversation_id,direction,source,content) VALUES ('secondary-message','a','secondary-conversation','in','contact','{"text":"Minha conversa"}')`),
  ])
  if (kind === 'whatsapp') await env.DB.prepare("INSERT INTO whatsapp_numbers(workspace_id,phone_e164,contact_id,first_connection_id) VALUES ('a','+5581999999999','secondary','secondary-channel')").run()
}

it('exige confirmação, limita 100 e valida todo o lote antes de descadastrar ou pausar', async () => {
  for (const [action, confirmation] of [['unsubscribe', 'DESCADASTRAR'], ['pause', 'PAUSAR']]) {
    expect((await request(`contacts/bulk-${action}`, { ids: ['c-a'], confirmation: 'sim' })).status).toBe(400)
    expect((await request(`contacts/bulk-${action}`, { ids: Array.from({ length: 101 }, () => 'c-a'), confirmation })).status).toBe(400)
    expect((await request(`contacts/bulk-${action}`, { ids: ['c-a', 'c-b'], confirmation })).status).toBe(404)
    expect(await env.DB.prepare("SELECT status FROM contacts WHERE id='c-a'").first('status')).toBe('subscribed')
    expect(await env.DB.prepare("SELECT automation_paused_until FROM contacts WHERE id='c-a'").first('automation_paused_until')).toBeNull()
  }
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rede não autorizada'))
  try {
    expect(await (await request('contacts/bulk-unsubscribe', { ids: ['c-a', 'c-a'], confirmation: 'DESCADASTRAR' })).json()).toEqual({ count: 1 })
    expect(await env.DB.prepare("SELECT opted_in FROM contact_channels WHERE id='cc-a'").first('opted_in')).toBe(0)
    expect(await env.DB.prepare("SELECT status FROM contacts WHERE id='c-a'").first('status')).toBe('unsubscribed')
    expect((await request('contacts/bulk-pause', { ids: ['c-a'], confirmation: 'PAUSAR' })).status).toBe(200)
    expect(await env.DB.prepare("SELECT automation_paused_until FROM contacts WHERE id='c-a'").first('automation_paused_until')).toBe(253402300799000)
    expect(network).not.toHaveBeenCalled()
  } finally { network.mockRestore() }
})

it('exporta somente os dados locais do contato com campos, tags e conversas e sem credenciais', async () => {
  await secondary()
  const response = await request('contacts/secondary/export')
  expect(response.status).toBe(200)
  const data = await response.json() as any
  expect(data.contact.id).toBe('secondary')
  expect(data.fields).toEqual([])
  expect(data.tags).toEqual([])
  const primary = await (await request('contacts/c-a/export')).json() as any
  expect(primary.fields).toEqual([{ id: 'field-a', name: 'Interesse', type: 'text', value: 'Curso' }])
  expect(primary.tags.map((tag: any) => tag.id)).toEqual(['tag-a'])
  expect(data.conversations).toHaveLength(1)
  expect(data.conversations[0].messages.some((m: any) => m.content.text === 'Minha conversa')).toBe(true)
  expect(JSON.stringify(data)).not.toMatch(/TESTONLY|credentials_|access_token|webhook_secret|c-b|user-b/)
  expect((await request('contacts/c-b/export')).status).toBe(404)
})

it('compara e impede identidades de mesmo canal mesmo que conexões sejam diferentes', async () => {
  await secondary('instagram', 'instagram_unified')
  const preview = await (await request('contacts/merge-preview', { primary_id: 'c-a', secondary_id: 'secondary' })).json() as any
  expect(preview.can_merge).toBe(false)
  expect(preview.conflicts).toHaveLength(1)
  expect(preview.primary.contact.id).toBe('c-a')
  expect(preview.secondary.contact.id).toBe('secondary')
  expect((await request('contacts/merge', { primary_id: 'c-a', secondary_id: 'secondary', confirmation: 'MESCLAR' })).status).toBe(409)
  expect(await env.DB.prepare("SELECT contact_id FROM contact_channels WHERE id='secondary-identity'").first('contact_id')).toBe('secondary')
  expect((await request('contacts/merge-preview', { primary_id: 'c-a', secondary_id: 'c-a' })).status).toBe(400)
  expect((await request('contacts/merge-preview', { primary_id: 'c-a', secondary_id: 'c-b' })).status).toBe(404)
})

it('mescla atomicamente mantendo primário, valores existentes, consentimento, identidades e conversa; cancela trabalho pendente', async () => {
  await secondary('whatsapp', 'meta_whatsapp_cloud')
  await env.DB.batch([
    env.DB.prepare("INSERT INTO tags(id,workspace_id,name) VALUES ('secondary-tag','a','Tag secundária')"),
    env.DB.prepare("INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES ('a','secondary','secondary-tag'),('a','secondary','tag-a')"),
    env.DB.prepare("INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES ('a','secondary','field-a','\"Outro valor\"')"),
    env.DB.prepare("INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('secondary-field','a','Outro campo','text')"),
    env.DB.prepare("INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES ('a','secondary','secondary-field','\"Valor novo\"')"),
    env.DB.prepare(`INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) SELECT 'merge-version','a','auto-a',1,draft_graph FROM automations WHERE id='auto-a'`),
    env.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,status) VALUES ('merge-run','a','secondary','merge-version','waiting_delay')"),
    env.DB.prepare("INSERT INTO button_tokens(token,workspace_id,run_id,node_id,step_index,button_id,expires_at) VALUES ('merge-token','a','merge-run','n',0,'b',9999999999999)"),
    env.DB.prepare("INSERT INTO sequences(id,workspace_id,name) VALUES ('merge-sequence','a','Sequência')"),
    env.DB.prepare("INSERT INTO sequence_subscriptions(workspace_id,sequence_id,contact_id) VALUES ('a','merge-sequence','secondary')"),
  ])
  expect((await request('contacts/merge', { primary_id: 'c-a', secondary_id: 'secondary', confirmation: 'sim' })).status).toBe(400)
  const preview = await (await request('contacts/merge-preview', { primary_id: 'c-a', secondary_id: 'secondary' })).json() as any
  expect(preview.can_merge).toBe(true)
  const merged = await request('contacts/merge', { primary_id: 'c-a', secondary_id: 'secondary', confirmation: 'MESCLAR' })
  expect(merged.status).toBe(200)
  const detail = await (await request('contacts/c-a')).json() as any
  expect(detail.contact).toMatchObject({ first_name: 'Mariana', last_name: 'Oliveira', email: 'secondary@example.test', phone: '5581999999999' })
  expect(detail.tags.map((t: any) => t.id).sort()).toEqual(['secondary-tag', 'tag-a'])
  expect(detail.field_values.map((v: any) => [v.field_id, v.value]).sort()).toEqual([['field-a', 'Curso'], ['secondary-field', 'Valor novo']])
  expect(detail.channels.find((ch: any) => ch.id === 'secondary-identity')).toMatchObject({ opted_in: true, contact_id: 'c-a' })
  expect(await env.DB.prepare("SELECT status FROM contacts WHERE id='secondary'").first('status')).toBe('deleted')
  expect(await env.DB.prepare("SELECT status FROM flow_runs WHERE id='merge-run'").first('status')).toBe('cancelled')
  expect(await env.DB.prepare("SELECT count(*) n FROM button_tokens WHERE run_id='merge-run'").first('n')).toBe(0)
  expect(await env.DB.prepare("SELECT count(*) n FROM sequence_subscriptions WHERE contact_id='secondary'").first('n')).toBe(0)
  const exported = await (await request('contacts/c-a/export')).json() as any
  expect(exported.conversations.find((v: any) => v.id === 'secondary-conversation').messages.some((m: any) => m.id === 'secondary-message')).toBe(true)
  expect(await env.DB.prepare("SELECT contact_id FROM whatsapp_numbers WHERE phone_e164='+5581999999999'").first('contact_id')).toBe('c-a')
  // An unrelated reassignment remains forbidden by the identity protection trigger.
  await expect(env.DB.prepare("UPDATE contact_channels SET contact_id='c-b' WHERE id='secondary-identity'").run()).rejects.toThrow('whatsapp_identity_immutable')
})

it('recusa excluídos e papéis sem edição sem alterar dados', async () => {
  await env.DB.prepare("UPDATE contacts SET status='deleted' WHERE id='c-a'").run()
  expect((await request('contacts/c-a/export')).status).toBe(404)
  expect((await request('contacts/bulk-pause', { ids: ['c-a'], confirmation: 'PAUSAR' })).status).toBe(404)
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE workspace_id='a'").run()
  expect((await request('contacts/bulk-unsubscribe', { ids: ['c-a'], confirmation: 'DESCADASTRAR' })).status).toBe(403)
  expect((await request('contacts/merge', { primary_id: 'c-a', secondary_id: 'c-b', confirmation: 'MESCLAR' })).status).toBe(403)
})

it('a autoria do histórico de grupos acompanha a mescla e a exclusão posterior do principal', async () => {
  await secondary('whatsapp', 'meta_whatsapp_cloud')
  await env.DB.batch([
    env.DB.prepare("INSERT INTO group_threads(id,workspace_id,channel_id,external_group_id) VALUES ('merge-group','a','secondary-channel','grupo-local')"),
    env.DB.prepare(`INSERT INTO group_messages(id,workspace_id,group_thread_id,author_contact_id,direction,content)
      VALUES ('merge-group-message','a','merge-group','secondary','in','{"text":"Histórico pessoal no grupo"}')`),
  ])
  expect((await request('contacts/merge', { primary_id: 'c-a', secondary_id: 'secondary', confirmation: 'MESCLAR' })).status).toBe(200)
  expect(await env.DB.prepare("SELECT author_contact_id FROM group_messages WHERE id='merge-group-message'").first('author_contact_id')).toBe('c-a')
  expect((await authenticatedRequest('contacts/c-a', 'a', { method: 'DELETE' }, undefined, { ...env, FLOW_RUN: undefined })).status).toBe(200)
  expect(await env.DB.prepare("SELECT count(*) n FROM group_messages WHERE id='merge-group-message'").first('n')).toBe(0)
})

it('uma falha no reparent desfaz também tags, campos, endereços e autorização da mescla', async () => {
  await secondary()
  await env.DB.prepare("CREATE TRIGGER portability_test_failure BEFORE UPDATE OF contact_id ON contact_channels WHEN OLD.id='secondary-identity' BEGIN SELECT RAISE(ABORT,'test_merge_rollback'); END").run()
  try {
    const response = await request('contacts/merge', { primary_id: 'c-a', secondary_id: 'secondary', confirmation: 'MESCLAR' })
    expect(response.status).toBe(500)
    expect(await env.DB.prepare("SELECT status FROM contacts WHERE id='secondary'").first('status')).toBe('subscribed')
    expect(await env.DB.prepare("SELECT email FROM contacts WHERE id='secondary'").first('email')).toBe('secondary@example.test')
    expect(await env.DB.prepare("SELECT email FROM contacts WHERE id='c-a'").first('email')).toBeNull()
    expect(await env.DB.prepare("SELECT contact_id FROM contact_channels WHERE id='secondary-identity'").first('contact_id')).toBe('secondary')
    expect(await env.DB.prepare("SELECT count(*) n FROM contact_merges").first('n')).toBe(0)
  } finally { await env.DB.prepare('DROP TRIGGER portability_test_failure').run() }
})


it('mesclar preserva o descadastro mais restritivo e a maior pausa dos dois contatos', async () => {
  await secondary()
  await env.DB.prepare("UPDATE contacts SET status='unsubscribed',automation_paused_until=253402300799000 WHERE id='secondary'").run()
  expect((await request('contacts/merge', { primary_id: 'c-a', secondary_id: 'secondary', confirmation: 'MESCLAR' })).status).toBe(200)
  expect(await env.DB.prepare("SELECT status,automation_paused_until FROM contacts WHERE id='c-a'").first()).toEqual({ status: 'unsubscribed', automation_paused_until: 253402300799000 })
})

it('mesclar leva a origem de anúncio do secundário só quando o principal não tem uma', async () => {
  await secondary()
  const origem = (id: string) => env.DB.prepare('SELECT ad_source_id,ad_source_type,ad_headline,ad_click_id,ad_source_url,ad_referred_at FROM contacts WHERE id=?').bind(id).first()
  await env.DB.prepare("UPDATE contacts SET ad_source_id='120330',ad_source_type='ad',ad_headline='Promoção',ad_click_id='CLK1',ad_source_url='https://fb.me/x',ad_referred_at=1760000000000 WHERE id='secondary'").run()
  expect((await request('contacts/merge', { primary_id: 'c-a', secondary_id: 'secondary', confirmation: 'MESCLAR' })).status).toBe(200)
  expect(await origem('c-a')).toEqual({ ad_source_id: '120330', ad_source_type: 'ad', ad_headline: 'Promoção', ad_click_id: 'CLK1', ad_source_url: 'https://fb.me/x', ad_referred_at: 1760000000000 })
  expect(await origem('secondary')).toEqual({ ad_source_id: null, ad_source_type: null, ad_headline: null, ad_click_id: null, ad_source_url: null, ad_referred_at: null })
})
it('mesclar mantém a origem de anúncio que o principal já tinha (só a primeira origem vale)', async () => {
  await secondary()
  await env.DB.batch([
    env.DB.prepare("UPDATE contacts SET ad_source_id='PRIMEIRO',ad_source_type='ad',ad_referred_at=1750000000000 WHERE id='c-a'"),
    env.DB.prepare("UPDATE contacts SET ad_source_id='OUTRO',ad_source_type='post',ad_headline='Outra',ad_referred_at=1760000000000 WHERE id='secondary'"),
  ])
  expect((await request('contacts/merge', { primary_id: 'c-a', secondary_id: 'secondary', confirmation: 'MESCLAR' })).status).toBe(200)
  expect(await env.DB.prepare("SELECT ad_source_id,ad_source_type,ad_headline,ad_referred_at FROM contacts WHERE id='c-a'").first()).toEqual({ ad_source_id: 'PRIMEIRO', ad_source_type: 'ad', ad_headline: null, ad_referred_at: 1750000000000 })
})

it('respostas e STOP a e-mails anteriores à mescla continuam ligados ao contato principal sem enviar mensagens', async () => {
  await secondary('email', 'cloudflare_email')
  await initialize(env, 'a')
  await env.DB.batch([
    env.DB.prepare(`UPDATE channels SET settings='{"emailStop":{"enabled":false}}' WHERE id='secondary-channel'`),
    env.DB.prepare("INSERT INTO email_messages(id,workspace_id,connection_id,contact_id,sender_id,recipient,message_id,reply_to,token,subject,text,html,intent,status,created_at) VALUES ('old-mail','a','secondary-channel','secondary','email-default-a','secondary@example.test','<old-mail@example.test>','reply+1234@mail.replica.test','1234','Assunto','Corpo','<p>Corpo</p>','human','sent',1000)"),
    env.DB.prepare("INSERT INTO email_events(id,workspace_id,message_id,contact_id,type,created_at) VALUES ('old-event','a','old-mail','secondary','sent',1000)"),
  ])
  expect((await request('contacts/merge', { primary_id: 'c-a', secondary_id: 'secondary', confirmation: 'MESCLAR' })).status).toBe(200)
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rede não autorizada'))
  try {
    const local = { ...env, FLOW_RUN: undefined, INBOUND: undefined, EMAIL: undefined }
    expect(await receiveReply(local, { from: 'secondary@example.test', to: 'reply+1234@mail.replica.test', inReplyTo: '<old-mail@example.test>', messageId: 'merge-reply', text: 'STOP' })).toMatchObject({ accepted: true, conversationId: 'secondary-conversation' })
    expect(await env.DB.prepare("SELECT contact_id FROM email_messages WHERE id='old-mail'").first('contact_id')).toBe('c-a')
    expect(await env.DB.prepare("SELECT contact_id FROM email_events WHERE id='old-event'").first('contact_id')).toBe('c-a')
    expect(await env.DB.prepare("SELECT opted_in FROM contact_channels WHERE id='secondary-identity'").first('opted_in')).toBe(0)
    expect(await env.DB.prepare("SELECT count(*) n FROM email_messages").first('n')).toBe(1)
    expect(network).not.toHaveBeenCalled()
  } finally { network.mockRestore() }
})

it('exclusão concorrente antes do lote não ressuscita o contato nem altera metade da seleção', async () => {
  await secondary()
  let changingContacts = false
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      if (sql.includes("UPDATE contacts SET status='unsubscribed'")) changingContacts = true
      return target.prepare(sql)
    }
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (changingContacts) await env.DB.prepare("UPDATE contacts SET status='deleted' WHERE id='secondary'").run()
      return env.DB.batch(statements)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' && key !== 'constructor' ? value.bind(target) : value
  } })
  const response = await authenticatedRequest('contacts/bulk-unsubscribe', 'a', { method: 'POST', body: JSON.stringify({ ids: ['c-a', 'secondary'], confirmation: 'DESCADASTRAR' }) }, undefined, { ...env, DB: db, FLOW_RUN: undefined })
  expect(response.status).toBe(404)
  expect(await env.DB.prepare("SELECT status FROM contacts WHERE id='secondary'").first('status')).toBe('deleted')
  expect(await env.DB.prepare("SELECT status FROM contacts WHERE id='c-a'").first('status')).toBe('subscribed')
  expect(await env.DB.prepare("SELECT opted_in FROM contact_channels WHERE id='cc-a'").first('opted_in')).toBe(1)
})
