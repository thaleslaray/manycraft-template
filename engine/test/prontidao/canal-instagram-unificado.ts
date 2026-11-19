import { canalMeta } from './canal-mensagens-meta'
import type { InstagramUnificadoGraph } from './simulador-instagram-unificado'

export const canalInstagramUnificado = (sim: InstagramUnificadoGraph) => canalMeta(sim, { tipo: 'instagram', provider: 'instagram_unified', objeto: 'instagram', campoConta: 'accountId', assinaWebhookSozinho: true })
