// Filtro do documento, contra o documento real e contra o cache.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	esquecerDocumento,
	METODOS,
	obterDocumento,
	prepararDocumento,
	TAG_CONGELADA,
	VALIDADE_MS,
	type DocumentoApi,
} from "../src/documento.ts";
import { criarFuncaoDePedido } from "../src/pedido.ts";
import { lerDocumentoReal, pularSemDocumento } from "./documento-real.ts";

test("filtro contra o documento real: nenhuma rota congelada fica, todas as outras ficam", { skip: pularSemDocumento() }, async () => {
	const original = lerDocumentoReal();
	const pronto = prepararDocumento(original);
	const congelados = Object.entries(original.paths).filter(([, ops]) => METODOS.some((m) => ops[m]?.tags?.includes(TAG_CONGELADA)));
	assert.ok(congelados.length > 0, "o documento real tem rotas congeladas");
	assert.equal(pronto.removidos, congelados.length);
	assert.equal(Object.keys(pronto.spec.paths).length, Object.keys(original.paths).length - congelados.length);
	for (const [caminho] of congelados) assert.ok(!(caminho in pronto.spec.paths), `${caminho} devia ter saído`);
	for (const ops of Object.values(pronto.spec.paths)) {
		for (const m of METODOS) assert.ok(!ops[m]?.tags?.includes(TAG_CONGELADA));
	}
	assert.ok("/api/contacts" in pronto.spec.paths);
	// O original não é alterado.
	assert.equal(Object.keys(original.paths).length, pronto.removidos + pronto.padroes.length);

	// Todo caminho do documento filtrado casa com o próprio padrão; nenhum congelado passa pela função de pedido.
	const motor = { chamadas: 0, fetch: async () => { motor.chamadas++; return Response.json({}); } };
	const pedir = criarFuncaoDePedido({ engine: motor as unknown as Fetcher, documento: pronto, authorization: "Bearer perfil:x", workspace: "w", registrar: () => {} });
	for (const [caminho, ops] of congelados) {
		const real = caminho.replace(/\{[^}/]+\}/g, "abc");
		const metodo = METODOS.find((m) => ops[m])!.toUpperCase() as "GET";
		await assert.rejects(pedir({ method: metodo, path: real }));
	}
	assert.equal(motor.chamadas, 0);
	for (const p of pronto.padroes) assert.ok(p.regex.test(p.modelo.replace(/\{[^}/]+\}/g, "abc")), p.modelo);
});

const docMinimo: DocumentoApi = {
	openapi: "3.1.0",
	paths: { "/api/tags": { get: { tags: ["Tags"] } }, "/api/public/x": { get: { tags: [TAG_CONGELADA] } } },
};

function motorDoDocumento(doc: DocumentoApi) {
	const m = { chamadas: [] as string[], fetch: async (url: string) => { m.chamadas.push(url); return Response.json(doc); } };
	return m;
}

function cacheFalso() {
	const guardado = new Map<string, Response>();
	return {
		guardado,
		match: async (k: RequestInfo | URL) => guardado.get(String(k))?.clone(),
		put: async (k: RequestInfo | URL, r: Response) => { guardado.set(String(k), r.clone()); },
	};
}

test("documento vem do motor pelo vínculo, fica em memória por 5 min e depois é relido", async () => {
	esquecerDocumento();
	let agora = 1_000;
	const motor = motorDoDocumento(docMinimo);
	const fonte = { engine: motor as unknown as Fetcher, agora: () => agora, registrar: () => {} };
	const a = await obterDocumento(fonte);
	assert.deepEqual(Object.keys(a.spec.paths), ["/api/tags"]);
	assert.equal(a.removidos, 1);
	assert.deepEqual(motor.chamadas, ["https://engine/api/docs/openapi.json"]);
	agora += VALIDADE_MS - 1;
	await obterDocumento(fonte);
	assert.equal(motor.chamadas.length, 1);
	agora += 2;
	await obterDocumento(fonte);
	assert.equal(motor.chamadas.length, 2);
});

test("isolado novo acha o documento filtrado na Cache API sem ir ao motor", async () => {
	esquecerDocumento();
	const cache = cacheFalso();
	const motor = motorDoDocumento(docMinimo);
	await obterDocumento({ engine: motor as unknown as Fetcher, cache, registrar: () => {} });
	assert.equal(motor.chamadas.length, 1);
	const [entrada] = [...cache.guardado.values()];
	assert.equal(entrada.headers.get("cache-control"), `max-age=${VALIDADE_MS / 1000}`);

	esquecerDocumento(); // como um isolado novo
	const pronto = await obterDocumento({ engine: motor as unknown as Fetcher, cache, registrar: () => {} });
	assert.equal(motor.chamadas.length, 1);
	assert.deepEqual(Object.keys(pronto.spec.paths), ["/api/tags"]);
	assert.equal(pronto.removidos, 1);
});

test("motor fora do ar: erro claro, sem endereço público de reserva", async () => {
	esquecerDocumento();
	const chamadas: string[] = [];
	const motor = { fetch: async (url: string) => { chamadas.push(url); return new Response("x", { status: 500 }); } };
	await assert.rejects(obterDocumento({ engine: motor as unknown as Fetcher, registrar: () => {} }), /Documento da API indisponível: o motor respondeu 500/);
	assert.deepEqual(chamadas, ["https://engine/api/docs/openapi.json"]);
});
