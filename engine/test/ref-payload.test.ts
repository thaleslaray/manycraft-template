import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { seed } from './fixtures'
import { refByCode, refPayloadStatement } from '../src/flow/ref-dispatch'
import { saveRefTrigger } from '../src/db/ref-links'
import type { FlowEnv } from '../src/flow/types'

const bindings = env as unknown as FlowEnv
beforeEach(async () => {
  await seed()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-ref','a','auto-a',1,(SELECT draft_graph FROM automations WHERE id='auto-a'))"),
    env.DB.prepare("UPDATE automations SET status='live',published_version_id='v-ref' WHERE id='auto-a'"),
    env.DB.prepare("UPDATE triggers SET kind='widget',widget_type='messenger_ref_url',status='active',config='{\"node_id\":\"t\",\"code\":\"abc123\",\"handle\":\"oficina\",\"payload_field_id\":\"field-a\"}' WHERE id='trg-a'"),
  ])
})

it('ref CODIGO--dados escolhe o gatilho pelo código e grava os dados no campo de texto configurado', async () => {
  expect((await refByCode(bindings, 'a', 'ch-a', 'abc123'))?.payload).toBeUndefined()
  const trigger = await refByCode(bindings, 'a', 'ch-a', 'abc123--Plano%20Azul')
  expect(trigger).toMatchObject({ id: 'trg-a', payload: 'Plano Azul' })
  expect(await refByCode(bindings, 'a', 'ch-a', 'zzz--x')).toBeUndefined()
  await refPayloadStatement(bindings, 'a', 'c-a', trigger)!.run()
  expect(await env.DB.prepare("SELECT value FROM contact_field_values WHERE contact_id='c-a' AND field_id='field-a'").first('value')).toBe('"Plano Azul"')
})

it('salvar o link recusa campo que não é texto de contato deste espaço', async () => {
  await env.DB.prepare("INSERT INTO custom_fields (id,workspace_id,name,type) VALUES ('field-num','a','Número','number')").run()
  await env.DB.prepare("UPDATE channels SET type='instagram' WHERE id='ch-a'").run()
  await expect(saveRefTrigger(env.DB, 'a', 'auto-a', { config: { handle: 'oficina', payload_field_id: 'field-num' } }, 'trg-a')).rejects.toThrow(/campo de texto/)
  await expect(saveRefTrigger(env.DB, 'a', 'auto-a', { config: { handle: 'oficina', payload_field_id: 'field-b' } }, 'trg-a')).rejects.toThrow(/campo de texto/)
})
