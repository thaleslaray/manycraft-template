import { canalMeta } from './canal-mensagens-meta'
import type { MessengerGraph } from './simulador-messenger'

export const canalMessenger = (sim: MessengerGraph) => canalMeta(sim, { tipo: 'messenger', provider: 'messenger_page', objeto: 'page', campoConta: 'pageId' })
