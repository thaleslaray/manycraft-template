/// <reference types="vite/client" />
import { expect, it } from 'vitest'
// Read as text through Vite: the workerd of the tests has no node:fs.
import envSource from '../src/env.ts?raw'
import integrationsSource from '../src/integrations.ts?raw'
import wranglerConfig from '../wrangler.jsonc?raw'
import devVarsExample from '../.dev.vars.example?raw'

// Names of the channel credentials that used to live in the Worker environment.
const channelSecrets = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_CHANNEL_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN',
  'IG_ACCESS_TOKEN', 'IG_ACCOUNT_ID', 'IG_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']

it('nenhuma credencial de conexão sobra no ambiente do Worker: só a chave mestra', () => {
  for (const [file, text] of Object.entries({ 'src/env.ts': envSource, 'wrangler.jsonc': wranglerConfig, '.dev.vars.example': devVarsExample })) {
    for (const name of channelSecrets) expect(text, `${file} ainda menciona ${name}`).not.toContain(name)
  }
  // IntegrationEnv (what webhooks, jobs and the layer receive) carries no channel secret either.
  expect(integrationsSource).not.toMatch(/extends\s+ChannelEnv/)
  expect(devVarsExample).toContain('CONNECTIONS_KEK_V1')
  expect(envSource).toContain('KeyringEnv')
})
