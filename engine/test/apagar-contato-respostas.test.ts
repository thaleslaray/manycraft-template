import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { publishAutomation } from '../src/db/automations'
import { authenticatedRequest, seedAuth } from './auth-helpers'

// Auditoria de segurança, grupo A (A6): apagar um contato apaga o que ele escreveu e o que foi escrito para ele. Só dados fictícios.
const panel = (path: string, method = 'GET') => authenticatedRequest(path, 'a', { method })
const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n

async function seedCollected() {
  const version = await publishAutomation(env.DB, 'a', 'auto-a')
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name,email) VALUES ('c-o','a','Outro','outro@example.test')"),
    ...(['c-a', 'c-o'] as const).flatMap((id, i) => [
      env.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id) VALUES (?,'a',?,?,'ch-a')").bind(`run-${id}`, id, version.id),
      env.DB.prepare("INSERT INTO flow_questions(run_id,step_index,workspace_id,contact_id,channel_id,node_id,config,token,expires_at) VALUES (?,0,'a',?,'ch-a','ask',?,?,?)")
        .bind(`run-${id}`, id, JSON.stringify({ text: 'Qual seu bairro?' }), `tok-${id}`, Date.now() + 86400_000),
      env.DB.prepare("INSERT INTO inbound_events(id,workspace_id,channel_id,payload) VALUES (?,'a','ch-a','{}')").bind(`in-${id}`),
      env.DB.prepare("INSERT INTO flow_question_answers(inbound_event_id,run_id,step_index,attempt,outcome,value,answered_at) VALUES (?,?,0,0,'success',?,?)")
        .bind(`in-${id}`, `run-${id}`, JSON.stringify(i === 0 ? 'RESPOSTA-FICTICIA-CENTRO' : 'RESPOSTA-DO-OUTRO'), Date.now()),
      env.DB.prepare("INSERT INTO email_senders(id,workspace_id,address,name,reply_to,verification_token) VALUES (?,'a',?,'Remetente',?,'v') ON CONFLICT DO NOTHING").bind(`snd-${id}`, `${id}@example.test`, `${id}@example.test`),
      env.DB.prepare("INSERT INTO email_messages(id,workspace_id,connection_id,contact_id,sender_id,recipient,message_id,reply_to,token,subject,text,html,intent,status,created_at) VALUES (?,'a','ch-a',?,?,?,?,?,?,'Assunto','Corpo','<p>Corpo</p>','human','sent',1000)")
        .bind(`mail-${id}`, id, `snd-${id}`, `${id}@example.test`, `<${id}@example.test>`, `r+${id}@example.test`, `t-${id}`),
      env.DB.prepare("INSERT INTO email_message_links(message_id,link_id,url) VALUES (?,'l1','https://example.test')").bind(`mail-${id}`),
      env.DB.prepare("INSERT INTO email_events(id,workspace_id,message_id,contact_id,type,created_at) VALUES (?,'a',?,?,'sent',1000)").bind(`ev-${id}`, `mail-${id}`, id),
      env.DB.prepare("INSERT INTO external_request_logs(id,workspace_id,contact_id,source,method,target,outcome) VALUES (?,'a',?,'run','GET','https://example.test','ok')").bind(`erl-${id}`, id),
      env.DB.prepare("INSERT INTO message_callbacks(workspace_id,contact_id,channel_id,url,method,expires_at) VALUES ('a',?,'ch-a','https://example.test','post',?)").bind(id, Date.now() + 86400_000),
      env.DB.prepare("INSERT INTO trigger_follow_ups(id,workspace_id,trigger_id,contact_id,channel_id,automation_id,created_at,due_at) VALUES (?,'a','trg-a',?,'ch-a','auto-a',1,2)").bind(`fu-${id}`, id),
    ]),
  ])
}
beforeEach(async () => { await seedAuth(); await seedCollected() })

describe('A6 apagar contato apaga o que ele escreveu e o que recebeu', () => {
  it('a rota de respostas não devolve mais o valor do contato apagado', async () => {
    const before = await (await panel('automations/auto-a/answers')).json() as { value: string; contact_id: string }[]
    expect(before.map(r => r.value).sort()).toEqual(['RESPOSTA-DO-OUTRO', 'RESPOSTA-FICTICIA-CENTRO'])
    const del = await panel('contacts/c-a', 'DELETE')
    expect(del.status).toBeLessThan(300)
    expect(await env.DB.prepare("SELECT status FROM contacts WHERE id='c-a'").first('status')).toBe('deleted')
    const after = await (await panel('automations/auto-a/answers')).json() as { value: string; contact_id: string }[]
    expect(after.some(r => r.value === 'RESPOSTA-FICTICIA-CENTRO' || r.contact_id === 'c-a')).toBe(false)
    expect(after.map(r => r.value)).toEqual(['RESPOSTA-DO-OUTRO'])
  })
  it('a rota de respostas ignora contato apagado mesmo se a linha sobrar (segunda barreira)', async () => {
    await env.DB.prepare("UPDATE contacts SET status='deleted' WHERE id='c-a'").run()
    const csv = await (await panel('automations/auto-a/answers?format=csv')).text()
    expect(csv).not.toContain('RESPOSTA-FICTICIA-CENTRO')
    expect(csv).toContain('RESPOSTA-DO-OUTRO')
  })
  it('as linhas de pergunta, resposta, e-mail, requisição, callback e follow-up do contato somem', async () => {
    expect((await panel('contacts/c-a', 'DELETE')).status).toBeLessThan(300)
    for (const [table, where] of [['flow_questions', "contact_id='c-a'"], ['flow_question_answers', "run_id='run-c-a'"], ['email_messages', "contact_id='c-a'"],
      ['email_message_links', "message_id='mail-c-a'"], ['email_events', "message_id='mail-c-a' OR contact_id='c-a'"], ['external_request_logs', "contact_id='c-a'"],
      ['message_callbacks', "contact_id='c-a'"], ['trigger_follow_ups', "contact_id='c-a'"]])
      expect(await count(`SELECT count(*) AS n FROM ${table} WHERE ${where}`), table).toBe(0)
  })
  it('outro contato do mesmo espaço não perde nada', async () => {
    expect((await panel('contacts/c-a', 'DELETE')).status).toBeLessThan(300)
    for (const [table, where] of [['flow_questions', "contact_id='c-o'"], ['flow_question_answers', "run_id='run-c-o'"], ['email_messages', "contact_id='c-o'"],
      ['email_message_links', "message_id='mail-c-o'"], ['email_events', "contact_id='c-o'"], ['external_request_logs', "contact_id='c-o'"],
      ['message_callbacks', "contact_id='c-o'"], ['trigger_follow_ups', "contact_id='c-o'"]])
      expect(await count(`SELECT count(*) AS n FROM ${table} WHERE ${where}`), table).toBe(1)
  })
  it('o último carrinho do contato apagado não sobra na linha (e o do outro fica)', async () => {
    await env.DB.prepare("UPDATE contacts SET last_cart=? WHERE id='c-a'").bind(JSON.stringify({ note: 'PEDIDO-FICTICIO-NOTA' })).run()
    await env.DB.prepare("UPDATE contacts SET last_cart=? WHERE id='c-o'").bind(JSON.stringify({ note: 'PEDIDO-DO-OUTRO' })).run()
    expect((await panel('contacts/c-a', 'DELETE')).status).toBeLessThan(300)
    expect(await env.DB.prepare("SELECT last_cart FROM contacts WHERE id='c-a'").first('last_cart')).toBeNull()
    expect(JSON.stringify(await (await panel('contacts/c-a')).json())).not.toContain('PEDIDO-FICTICIO-NOTA')
    expect(await env.DB.prepare("SELECT last_cart FROM contacts WHERE id='c-o'").first('last_cart')).toContain('PEDIDO-DO-OUTRO')
  })
  it('depois de mesclar, apagar o principal alcança também respostas, e-mails, notificações e registros do secundário', async () => {
    await env.DB.batch(['c-a', 'c-o'].flatMap(id => [
      env.DB.prepare("INSERT INTO team_notifications(id,workspace_id,contact_id,run_id,message) VALUES (?,'a',?,?,?)").bind(`not-${id}`, id, `run-${id}`, `AVISO-FICTICIO-${id}`),
      env.DB.prepare("INSERT INTO flow_random_assignments(workspace_id,automation_id,contact_id,node_id,variation_id) VALUES ('a','auto-a',?,'rnd','v1')").bind(id),
    ]))
    const merged = await authenticatedRequest('contacts/merge', 'a', { method: 'POST', body: JSON.stringify({ primary_id: 'c-a', secondary_id: 'c-o', confirmation: 'MESCLAR' }) })
    expect(merged.status).toBe(200)
    expect(await env.DB.prepare("SELECT status FROM contacts WHERE id='c-o'").first('status')).toBe('deleted')
    // nada fica com o id do secundário; o que era dele agora é do principal (a linha repetida do principal vence)
    for (const table of ['flow_questions', 'email_messages', 'email_events', 'external_request_logs', 'message_callbacks', 'trigger_follow_ups', 'team_notifications', 'flow_random_assignments', 'flow_runs'])
      expect(await count(`SELECT count(*) AS n FROM ${table} WHERE contact_id='c-o'`), table).toBe(0)
    expect(await count("SELECT count(*) AS n FROM email_messages WHERE contact_id='c-a'")).toBe(2)
    expect(await count("SELECT count(*) AS n FROM message_callbacks WHERE contact_id='c-a'")).toBe(1)
    expect(await count("SELECT count(*) AS n FROM flow_random_assignments WHERE contact_id='c-a'")).toBe(1)
    expect(await count("SELECT count(*) AS n FROM team_notifications WHERE contact_id='c-a'")).toBe(2)
    expect(await count("SELECT count(*) AS n FROM flow_question_answers WHERE run_id='run-c-o'")).toBe(1)
    expect((await panel('contacts/c-a', 'DELETE')).status).toBeLessThan(300)
    for (const [table, where] of [['flow_questions', "contact_id IN ('c-a','c-o')"], ['flow_question_answers', "run_id IN ('run-c-a','run-c-o')"], ['email_messages', "contact_id IN ('c-a','c-o')"],
      ['email_message_links', "message_id IN ('mail-c-a','mail-c-o')"], ['email_events', "contact_id IN ('c-a','c-o')"], ['external_request_logs', "contact_id IN ('c-a','c-o')"],
      ['team_notifications', "contact_id IN ('c-a','c-o')"], ['trigger_follow_ups', "contact_id IN ('c-a','c-o')"], ['message_callbacks', "contact_id IN ('c-a','c-o')"]])
      expect(await count(`SELECT count(*) AS n FROM ${table} WHERE ${where}`), table).toBe(0)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM team_notifications WHERE message LIKE 'AVISO-FICTICIO%'").first('n')).toBe(0)
  })
})
