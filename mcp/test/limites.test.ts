// Limites por execução de `execute`: teto de pedidos ao motor (contado por chamada de executor.execute), tempo e CPU.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Executor, ResolvedProvider } from "@cloudflare/codemode";
import { prepararDocumento, type DocumentoApi } from "../src/documento.ts";
import { CPU_MAXIMO_MS, TEMPO_MAXIMO_MS, TETO_PEDIDOS_POR_EXECUCAO, limitarPedidosPorExecucao, loaderComLimites } from "../src/limites.ts";
import { criarFuncaoDePedido } from "../src/pedido.ts";

const recorte: DocumentoApi = { openapi: "3.1.0", info: { title: "t", version: "1" }, paths: { "/api/tags": { get: {} } } };

test("valores combinados: 50 pedidos, 30 segundos", () => {
	assert.equal(TETO_PEDIDOS_POR_EXECUCAO, 50);
	assert.equal(TEMPO_MAXIMO_MS, 30_000);
	assert.ok(CPU_MAXIMO_MS > 0 && CPU_MAXIMO_MS <= TEMPO_MAXIMO_MS);
});

/** Executor falso: roda o "código" chamando a função `request` do provedor N vezes, como o ambiente isolado faria. */
function executorFalso(vezes: number): Executor {
	return {
		async execute(_code, providers) {
			const fns = (providers as ResolvedProvider[])[0].fns;
			const resultados: string[] = [];
			for (let i = 0; i < vezes; i++) {
				try { await fns.request({ method: "GET", path: "/api/tags" }); resultados.push("ok"); }
				catch (e) { resultados.push((e as Error).message); }
			}
			return { result: resultados };
		},
	};
}

function montar(vezes: number) {
	const chamadas: string[] = [];
	const engine = { fetch: async (url: string) => { chamadas.push(url); return Response.json([]); } };
	const request = criarFuncaoDePedido({ engine: engine as unknown as Fetcher, documento: prepararDocumento(recorte), authorization: "Bearer perfil:k", workspace: "w", registrar: () => {} });
	const executor = limitarPedidosPorExecucao(executorFalso(vezes));
	// Igual ao openApiMcpServer: um provedor "__openapiHost" com a função request.
	const executar = () => executor.execute("async () => {}", [{ name: "__openapiHost", fns: { request: (a: unknown) => request(a as never) } }]);
	return { executar, chamadas };
}

test("o 51º pedido de uma execução é recusado sem chamar o motor", async () => {
	const { executar, chamadas } = montar(60);
	const { result } = await executar();
	const r = result as string[];
	assert.equal(chamadas.length, 50);
	assert.deepEqual(r.slice(0, 50), Array(50).fill("ok"));
	assert.equal(r.length, 60);
	for (const m of r.slice(50)) {
		assert.match(m, /50 pedidos/);
		assert.match(m, /mais de uma chamada/);
	}
});

test("uma execução nova começa do zero", async () => {
	const { executar, chamadas } = montar(50);
	await executar();
	const segunda = (await executar()).result as string[];
	assert.deepEqual(segunda, Array(50).fill("ok"));
	assert.equal(chamadas.length, 100);
});

test("execuções simultâneas (lote JSON-RPC) têm contadores separados", async () => {
	const { executar, chamadas } = montar(30);
	const [a, b] = await Promise.all([executar(), executar()]);
	assert.deepEqual(a.result, Array(30).fill("ok"));
	assert.deepEqual(b.result, Array(30).fill("ok"));
	assert.equal(chamadas.length, 60);
});

test("search (sem provedores) passa direto", async () => {
	let recebeu: unknown;
	const executor = limitarPedidosPorExecucao({ execute: async (_c, p) => { recebeu = p; return { result: 1 }; } });
	assert.deepEqual(await executor.execute("x", []), { result: 1 });
	assert.deepEqual(recebeu, []);
});

test("o ambiente isolado é carregado com o teto de CPU", () => {
	const recebidos: WorkerLoaderWorkerCode[] = [];
	const loader = { load: (c: WorkerLoaderWorkerCode) => { recebidos.push(c); return {} as WorkerStub; }, get: () => ({}) as WorkerStub } as unknown as WorkerLoader;
	loaderComLimites(loader).load({ compatibilityDate: "2025-06-01", mainModule: "executor.js", modules: { "executor.js": "" } });
	assert.deepEqual(recebidos[0].limits, { cpuMs: CPU_MAXIMO_MS });
	// um limite menor já pedido pelo código é mantido
	loaderComLimites(loader).load({ compatibilityDate: "2025-06-01", mainModule: "m.js", modules: { "m.js": "" }, limits: { cpuMs: 10 } });
	assert.equal(recebidos[1].limits?.cpuMs, 10);
});
