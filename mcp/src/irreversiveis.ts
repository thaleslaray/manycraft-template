// Trava de irreversíveis. O codemode não pede aprovação por chamada (o cliente aprova o bloco de código inteiro),
// então a trava fica na função de pedido: as operações abaixo são recusadas sem chamar o motor, a não ser que quem
// cadastrou o conector tenha mandado o cabeçalho x-manycraft-irreversiveis: permitir (lido em entrada.ts).
//
// Entram todo DELETE e as operações de outros métodos que enviam algo para uma pessoa ou serviço de fora, ou que não
// têm volta pela própria API. O que dá para desfazer pela API sem efeito fora do sistema (lixeira com restaurar,
// pausar, arquivar, publicar automação) não entra.
//
// Os caminhos são os do documento da API (.scratch/api-docs/openapi.json). Dois testes conferem a lista contra o
// documento real: toda entrada precisa existir e todo DELETE precisa estar aqui.
import type { Metodo } from "./documento.ts";
import { PedidoRecusado, type PedidoConferido } from "./pedido.ts";

export const MENSAGEM_BLOQUEIO = 'Ação irreversível bloqueada. Para liberar, o dono conecta o ManyCraft de novo marcando "permitir ações sem volta" (pelos cabeçalhos, x-manycraft-irreversiveis: permitir).';

export interface Irreversivel {
	metodo: Metodo;
	caminho: string; // como no documento, ex.: /api/contacts/{id}
	motivo: string;
	/**
	 * Só para operações que dependem do corpo: devolve true quando aquele pedido é irreversível.
	 * Sem corpo legível o pedido é tratado como irreversível (o caminho mais seguro).
	 */
	quando?: (corpo: Record<string, unknown> | undefined) => boolean;
}

export const IRREVERSIVEIS: readonly Irreversivel[] = [
	// ---- todo DELETE ----
	{ metodo: "DELETE", caminho: "/api/apps/{id}", motivo: "Desinstala o app e apaga a configuração dele." },
	{ metodo: "DELETE", caminho: "/api/automations/{id}", motivo: "Exclui de vez uma automação da lixeira." },
	{ metodo: "DELETE", caminho: "/api/automations/{id}/share", motivo: "Revoga o link público: quem recebeu o link perde o acesso." },
	{ metodo: "DELETE", caminho: "/api/automations/{id}/triggers/{triggerId}", motivo: "Remove o gatilho com a configuração dele." },
	{ metodo: "DELETE", caminho: "/api/inbox/conversations/{id}/scheduled/{scheduledId}", motivo: "Cancela uma mensagem agendada; o texto não volta." },
	{ metodo: "DELETE", caminho: "/api/inbox/groups/{id}", motivo: "Exclui o grupo e as regras de atribuição que apontavam para ele." },
	{ metodo: "DELETE", caminho: "/api/inbox/labels/{id}", motivo: "Exclui a etiqueta e a tira de todas as conversas." },
	{ metodo: "DELETE", caminho: "/api/inbox/saved-replies/{id}", motivo: "Exclui a resposta salva." },
	{ metodo: "DELETE", caminho: "/api/fields/{id}", motivo: "Exclui o campo e os valores gravados nos contatos." },
	{ metodo: "DELETE", caminho: "/api/connections/{id}", motivo: "Arquiva a conexão: o canal para de responder e não volta pela API." },
	{ metodo: "DELETE", caminho: "/api/connections/{id}/username", motivo: "Remove o nome de usuário do número no provedor." },
	{ metodo: "DELETE", caminho: "/api/contacts/{id}", motivo: "Exclui o contato com conversas, respostas e dados." },
	{ metodo: "DELETE", caminho: "/api/contacts/{id}/sequences/{sequence}", motivo: "Tira o contato da sequência e perde o ponto em que ele estava." },
	{ metodo: "DELETE", caminho: "/api/email/rules/{id}", motivo: "Manda a regra de e-mail para a lixeira, sem rota de restaurar na API." },
	{ metodo: "DELETE", caminho: "/api/email/segments/{id}", motivo: "Exclui o segmento de e-mail." },
	{ metodo: "DELETE", caminho: "/api/email/marketing-provider", motivo: "Apaga a chave do provedor de marketing; os envios param." },
	{ metodo: "DELETE", caminho: "/api/team/{id}", motivo: "Remove o membro e revoga as chaves de API dele." },
	{ metodo: "DELETE", caminho: "/api/team/invites/{id}", motivo: "Cancela o convite já enviado por e-mail." },
	{ metodo: "DELETE", caminho: "/api/team/access-requests/{id}", motivo: "Recusa e apaga o pedido de acesso." },
	{ metodo: "DELETE", caminho: "/api/integrations/google-sheets", motivo: "Desconecta o Google Sheets e apaga a conta de serviço guardada." },
	{ metodo: "DELETE", caminho: "/api/me/alerts/chat", motivo: "Desvincula o chat dos avisos." },
	{ metodo: "DELETE", caminho: "/api/keywords/{id}", motivo: "Exclui a regra de palavra-chave." },
	{ metodo: "DELETE", caminho: "/api/folders/{id}", motivo: "Exclui a pasta de automações." },
	{ metodo: "DELETE", caminho: "/api/settings-folders/{id}", motivo: "Exclui a pasta de campos ou tags." },
	{ metodo: "DELETE", caminho: "/api/rules/{id}", motivo: "Exclui a regra." },
	{ metodo: "DELETE", caminho: "/api/segments/{id}", motivo: "Exclui o segmento." },
	{ metodo: "DELETE", caminho: "/api/sequences/{id}", motivo: "Exclui a sequência e tira os contatos inscritos." },
	{ metodo: "DELETE", caminho: "/api/tags/{id}", motivo: "Exclui a tag e a tira dos contatos." },
	{ metodo: "DELETE", caminho: "/api/notification-topics/{id}", motivo: "Exclui o tópico de notificação e as inscrições." },
	{ metodo: "DELETE", caminho: "/api/broadcasts/{id}", motivo: "Exclui a transmissão com os destinatários." },
	{ metodo: "DELETE", caminho: "/api/site-widgets/{id}", motivo: "Exclui o widget: o botão some do site." },

	// ---- contatos ----
	{ metodo: "POST", caminho: "/api/contacts/bulk-delete", motivo: "Exclui até 100 contatos de uma vez." },
	{ metodo: "POST", caminho: "/api/contacts/bulk-unsubscribe", motivo: "Descadastra e retira o consentimento: recolocar exige novo aceite da pessoa." },
	{
		metodo: "POST", caminho: "/api/contacts/cleanup",
		motivo: "Com apply, exclui ou descadastra todos os contatos inativos (só contar ou pôr tag passa).",
		quando: (c) => !c || (c.apply === true && c.action !== "tag"),
	},
	{ metodo: "POST", caminho: "/api/contacts/merge", motivo: "Junta dois contatos: o segundo deixa de existir e as automações dele são canceladas." },
	{ metodo: "POST", caminho: "/api/contacts/bulk-sequence", motivo: "Inscreve contatos numa sequência, que manda mensagens a eles." },
	{ metodo: "POST", caminho: "/api/contact-imports", motivo: "Importa o CSV e sobrescreve dados de contatos existentes, sem guardar os anteriores." },

	// ---- transmissões ----
	{
		metodo: "POST", caminho: "/api/broadcasts",
		motivo: "Com status sending envia na hora, com scheduled agenda o envio; só rascunho (draft) passa.",
		quando: (c) => !c || c.status !== "draft",
	},
	{ metodo: "POST", caminho: "/api/broadcasts/{id}/resume", motivo: "Retoma o envio da transmissão para os contatos." },
	{ metodo: "POST", caminho: "/api/broadcasts/{id}/test", motivo: "Envia a transmissão de teste para um contato real." },

	// ---- caixa de entrada ----
	{ metodo: "POST", caminho: "/api/inbox/conversations", motivo: "Inicia conversa com um número novo, mandando um modelo." },
	{ metodo: "POST", caminho: "/api/inbox/conversations/{id}/messages", motivo: "Manda mensagem ao contato." },
	{ metodo: "POST", caminho: "/api/inbox/conversations/{id}/scheduled", motivo: "Agenda mensagem que sai sozinha para o contato." },
	{ metodo: "POST", caminho: "/api/inbox/conversations/{id}/run-automation", motivo: "Roda uma automação para o contato, que pode mandar mensagens." },
	{ metodo: "POST", caminho: "/api/inbox/conversations/{id}/resume-automations", motivo: "Os fluxos que esperavam seguem e podem mandar mensagens na hora." },

	// ---- envios de teste para fora ----
	{ metodo: "POST", caminho: "/api/email/test", motivo: "Envia um e-mail de teste para um endereço." },
	{ metodo: "POST", caminho: "/api/external-requests/test", motivo: "Faz de verdade a requisição para o serviço externo." },

	// ---- conexões ----
	{ metodo: "POST", caminho: "/api/connections", motivo: "Registra as credenciais e o webhook no provedor, o que pode tirar o número ou o bot de outro sistema." },
	{
		metodo: "POST", caminho: "/api/connections/{id}/enabled",
		motivo: "Desligar desconecta o canal, que para de responder; só ligar (enabled: true) passa.",
		quando: (c) => !c || c.enabled !== true,
	},
	{ metodo: "POST", caminho: "/api/connections/{id}/rotate", motivo: "Troca as credenciais e registra o webhook de novo; as antigas se perdem." },
	{ metodo: "POST", caminho: "/api/connections/{id}/thread-control", motivo: "Passa ou toma o controle da conversa entre apps no provedor." },

	// ---- equipe, modelos e integrações ----
	{ metodo: "POST", caminho: "/api/team/invites", motivo: "Manda e-mail de convite para a pessoa." },
	{ metodo: "POST", caminho: "/api/team/access-requests/{id}/approve", motivo: "Dá a uma pessoa de fora acesso aos dados do espaço." },
	{ metodo: "POST", caminho: "/api/message-templates/{connection}/{id}/submit", motivo: "Manda o modelo para revisão do provedor; não dá para retirar." },
	{ metodo: "POST", caminho: "/api/integrations/google-sheets/export-contacts", motivo: "Copia dados de contatos para uma planilha fora do sistema." },
];

const porChave = new Map(IRREVERSIVEIS.map((e) => [`${e.metodo} ${e.caminho}`, e]));

/** DELETE que ainda não está na lista (rota nova que chegou pelo documento do motor antes desta lista). */
const DELETE_SEM_ENTRADA: Omit<Irreversivel, "caminho"> = { metodo: "DELETE", motivo: "Todo DELETE é tratado como irreversível." };

/** Lê o corpo como o motor leria: objeto como veio, texto cru (rawBody) como JSON. Fora disso, undefined. */
function lerCorpo(corpo: unknown): Record<string, unknown> | undefined {
	let valor = corpo;
	if (typeof valor === "string") {
		try { valor = JSON.parse(valor); } catch { return undefined; }
	}
	return valor && typeof valor === "object" && !Array.isArray(valor) ? (valor as Record<string, unknown>) : undefined;
}

/** A entrada da lista que torna este pedido irreversível, ou undefined se ele pode seguir sem liberação. */
export function acharIrreversivel(pedido: Pick<PedidoConferido, "metodo" | "modelo"> & { caminho?: string; corpo?: unknown }): Irreversivel | undefined {
	const entrada = porChave.get(`${pedido.metodo} ${pedido.modelo}`);
	if (entrada) return !entrada.quando || entrada.quando(lerCorpo(pedido.corpo)) ? entrada : undefined;
	if (pedido.metodo === "DELETE") return { ...DELETE_SEM_ENTRADA, caminho: pedido.modelo };
	return undefined;
}

/**
 * Gancho `antesDoPedido` da função de pedido. `liberado` vem só do cabeçalho do conector (entrada.ts), fixado quando
 * o servidor MCP é criado; nada no pedido do modelo muda esse valor.
 */
export function travaDeIrreversiveis(liberado: boolean): (pedido: PedidoConferido) => void {
	return (pedido) => {
		if (!liberado && acharIrreversivel(pedido)) throw new PedidoRecusado(MENSAGEM_BLOQUEIO);
	};
}
