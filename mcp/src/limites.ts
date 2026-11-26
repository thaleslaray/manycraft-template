// Limites por execução de `execute`. Os três valores ficam aqui, num só lugar.
//
// - Teto de pedidos: contado em volta do executor. O openApiMcpServer() chama executor.execute() uma vez por chamada
//   da ferramenta (`search` ou `execute`), passando a função de pedido como provedor; cada execute() ganha um contador
//   novo. Assim a conta é por execução, não por isolado, por conexão nem por requisição HTTP (um lote JSON-RPC com duas
//   chamadas de `execute` dá duas execuções e dois contadores).
// - Tempo: opção `timeout` do DynamicWorkerExecutor (padrão do pacote 0.5.6: 60 s). É um setTimeout dentro do ambiente
//   isolado, em corrida com o código: corta espera longa (await), mas não corta laço síncrono, que não devolve a vez.
// - CPU: `limits.cpuMs` do Worker carregado (Dynamic Workers, "Custom resource limits"). Passou, o runtime lança
//   exceção na hora. O DynamicWorkerExecutor não expõe essa opção, então o loader é embrulhado para acrescentá-la.
import type { Executor, ResolvedProvider } from "@cloudflare/codemode";
import { PedidoRecusado } from "./pedido.ts";

/** Pedidos ao motor (chamadas à função de pedido) por chamada de `execute`. */
export const TETO_PEDIDOS_POR_EXECUCAO = 50;
/** Tempo de parede por execução no ambiente isolado. */
export const TEMPO_MAXIMO_MS = 30_000;
/**
 * CPU do código do modelo no ambiente isolado, por execução. No protótipo (ficha 01) a chamada mais pesada, um `search`
 * que carrega o documento inteiro no isolado, ficou em até ~230 ms de CPU somando host e isolado; `execute` passa quase
 * todo o tempo esperando o motor (23–90 ms de CPU). 5 s dá mais de 20 vezes essa folga e ainda corta um laço infinito
 * em 5 s de CPU, em vez dos 30 s (até 5 min) de CPU do plano pago.
 */
export const CPU_MAXIMO_MS = 5_000;

export const mensagemDoTeto = (teto: number) =>
	`Teto de ${teto} pedidos à API por execução atingido: este pedido não foi feito. Divida o trabalho em mais de uma chamada de execute (por exemplo, uma página por chamada).`;

/** Embrulha o executor para que cada execução tenha o próprio contador de pedidos. */
export function limitarPedidosPorExecucao(executor: Executor, teto = TETO_PEDIDOS_POR_EXECUCAO): Executor {
	return {
		execute(code, providersOrFns, options) {
			// Formato antigo (funções soltas) não é usado pelo openApiMcpServer(); passa como veio.
			if (!Array.isArray(providersOrFns)) return executor.execute(code, providersOrFns, options);
			let feitos = 0;
			const contados: ResolvedProvider[] = providersOrFns.map((p) => ({
				...p,
				fns: Object.fromEntries(
					Object.entries(p.fns).map(([nome, fn]) => [
						nome,
						async (...args: unknown[]) => {
							feitos++;
							if (feitos > teto) throw new PedidoRecusado(mensagemDoTeto(teto));
							return fn(...args);
						},
					]),
				),
			}));
			return executor.execute(code, contados, options);
		},
	};
}

/** Loader que carrega todo Worker com o teto de CPU (mantém um limite menor, se o código já pedir um). */
export function loaderComLimites(loader: WorkerLoader, cpuMs = CPU_MAXIMO_MS): WorkerLoader {
	const comLimite = (code: WorkerLoaderWorkerCode): WorkerLoaderWorkerCode => ({
		...code,
		limits: { ...code.limits, cpuMs: Math.min(code.limits?.cpuMs ?? cpuMs, cpuMs) },
	});
	return {
		load: (code) => loader.load(comLimite(code)),
		get: (nome, getCode) => loader.get(nome, async () => comLimite(await getCode())),
	};
}
