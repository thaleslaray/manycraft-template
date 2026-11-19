import { SimuladorMensagens } from './simulador-meta-mensagens'

/** Messenger Platform: host graph.facebook.com, Página identificada pelo id da Página. */
export class MessengerGraph extends SimuladorMensagens {
  constructor(contaId = '110022003300440') { super({ host: 'graph.facebook.com', contaId, rotuloConta: 'messenger', nome: 'messenger-graph' }) }
}
