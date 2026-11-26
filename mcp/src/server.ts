// MCP do ManyCraft em Code Mode ("search and execute"), no padrão do guia da Cloudflare
// developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-mcp-server/
// Duas ferramentas: `search` filtra o documento da API dentro do ambiente isolado; `execute` chama a API pela função de pedido.
// Desde a ficha 07 o Worker é também o servidor de autorização (provedor.ts): este arquivo é o handler da rota /mcp, que
// recebe em ctx.props a chave, o espaço e a liberação de irreversíveis, venham do login ou dos cabeçalhos antigos.
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { openApiMcpServer } from "@cloudflare/codemode/mcp";
import { createLegacyMcpHandler } from "agents/mcp";
import { TEXTO_EXECUTE } from "./descricao.ts";
import { DocumentoIndisponivel, obterDocumento } from "./documento.ts";
import { ROTA_MCP } from "./entrada.ts";
import { travaDeIrreversiveis } from "./irreversiveis.ts";
import { limitarPedidosPorExecucao, loaderComLimites, TEMPO_MAXIMO_MS } from "./limites.ts";
import { criarFuncaoDePedido } from "./pedido.ts";
import { criarWorker, type EnvDoConector, type PropsDoConector } from "./provedor.ts";

export interface Env extends EnvDoConector {
	LOADER: WorkerLoader;
	ENGINE: Fetcher;
}

/** Handler da rota /mcp. O provedor já conferiu o token (do login ou dos cabeçalhos) e a chave no motor. */
const mcp = {
	async fetch(request: Request, envDoConector: EnvDoConector, ctx: ExecutionContext & { props?: unknown }): Promise<Response> {
		const env = envDoConector as Env;
		const entrada = ctx.props as PropsDoConector;
		const cache = typeof caches !== "undefined" ? caches.default : undefined;
		const esperar = (p: Promise<unknown>) => ctx.waitUntil(p);

		let documento;
		try {
			documento = await obterDocumento({
				engine: env.ENGINE,
				cache,
				esperar,
			});
		} catch (e) {
			const mensagem = e instanceof DocumentoIndisponivel ? e.message : "Documento da API indisponível.";
			return Response.json({ error: mensagem }, { status: 503 });
		}

		const server = openApiMcpServer({
			spec: documento.spec,
			// Limites por execução (limites.ts): teto de pedidos em volta do executor, tempo pela opção do pacote e CPU
			// no Worker carregado.
			executor: limitarPedidosPorExecucao(new DynamicWorkerExecutor({ loader: loaderComLimites(env.LOADER), timeout: TEMPO_MAXIMO_MS })),
			name: "manycraft",
			version: "1.0.0",
			description: TEXTO_EXECUTE,
			request: criarFuncaoDePedido({
				engine: env.ENGINE,
				documento,
				authorization: entrada.authorization,
				workspace: entrada.workspace,
				// Trava de irreversíveis: liberada só por quem conectou (caixa marcada na tela de conexão do painel, ou o
				// cabeçalho x-manycraft-irreversiveis no caminho antigo).
				ganchos: { antesDoPedido: travaDeIrreversiveis(entrada.irreversiveisLiberados) },
			}),
		});

		return createLegacyMcpHandler(server, { route: ROTA_MCP })(request, env, ctx);
	},
};

export default criarWorker(mcp);
