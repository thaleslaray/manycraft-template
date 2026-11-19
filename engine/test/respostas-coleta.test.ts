import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { publishAutomation } from '../src/db/automations'

beforeEach(seedAuth)

it('lista as respostas aceitas da coleta e exporta CSV sem fórmula', async () => {
  const version = await publishAutomation(env.DB, 'a', 'auto-a')
  await env.DB.batch([
    env.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id) VALUES ('run-q','a','c-a',?,'ch-a')").bind(version.id),
    env.DB.prepare("INSERT INTO flow_questions(run_id,step_index,workspace_id,contact_id,channel_id,node_id,config,token,expires_at) VALUES ('run-q',0,'a','c-a','ch-a','ask',?,'tok-q',?)")
      .bind(JSON.stringify({ text: 'Qual seu bairro?' }), Date.now() + 86400_000),
    env.DB.prepare("INSERT INTO inbound_events(id,workspace_id,channel_id,payload) VALUES ('in-q','a','ch-a','{}')"),
    env.DB.prepare("INSERT INTO flow_question_answers(inbound_event_id,run_id,step_index,attempt,outcome,value,answered_at) VALUES ('in-q','run-q',0,0,'success',?,?)").bind(JSON.stringify('=Centro'), Date.now()),
  ])
  const json = await (await authenticatedRequest('automations/auto-a/answers')).json() as { question: string; value: string; contact_id: string }[]
  expect(json).toEqual([expect.objectContaining({ question: 'Qual seu bairro?', value: '=Centro', contact_id: 'c-a' })])
  const csv = await authenticatedRequest('automations/auto-a/answers?format=csv')
  expect(csv.headers.get('content-type')).toContain('text/csv')
  const text = await csv.text()
  expect(text.split('\n')[0]).toBe('respondido_em,pergunta,resposta,contato,contato_id,email,telefone')
  expect(text).toContain("'=Centro")
})
