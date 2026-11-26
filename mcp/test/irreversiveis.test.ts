// Trava de irreversíveis: a lista contra o documento real e o bloqueio na função de pedido, com motor falso.
import assert from "node:assert/strict";
import { test } from "node:test";
import { METODOS, prepararDocumento, type DocumentoApi } from "../src/documento.ts";
import { IRREVERSIVEIS, MENSAGEM_BLOQUEIO, acharIrreversivel, travaDeIrreversiveis } from "../src/irreversiveis.ts";
import { criarFuncaoDePedido } from "../src/pedido.ts";
import { lerDocumentoReal, pularSemDocumento } from "./documento-real.ts";

test("mensagem de bloqueio é exatamente a combinada", () => {
	assert.equal(MENSAGEM_BLOQUEIO, 'Ação irreversível bloqueada. Para liberar, o dono conecta o ManyCraft de novo marcando "permitir ações sem volta" (pelos cabeçalhos, x-manycraft-irreversiveis: permitir).');
});

test("toda entrada da lista tem motivo em português e não se repete", () => {
	const vistos = new Set<string>();
	for (const e of IRREVERSIVEIS) {
		const chave = `${e.metodo} ${e.caminho}`;
		assert.ok(!vistos.has(chave), `repetida: ${chave}`);
		vistos.add(chave);
		assert.ok(e.motivo.trim().length >= 10, `motivo curto demais: ${chave}`);
	}
});

test("toda entrada da lista existe no documento real (filtrado)", { skip: pularSemDocumento() }, () => {
	const { spec } = prepararDocumento(lerDocumentoReal());
	const faltam = IRREVERSIVEIS.filter((e) => !spec.paths[e.caminho]?.[e.metodo.toLowerCase()]).map((e) => `${e.metodo} ${e.caminho}`);
	assert.deepEqual(faltam, [], `entradas da lista que não existem no documento: ${faltam.join(", ")}`);
});

test("todo DELETE do documento real (filtrado) está na lista", { skip: pularSemDocumento() }, () => {
	const { spec } = prepararDocumento(lerDocumentoReal());
	const listados = new Set(IRREVERSIVEIS.map((e) => `${e.metodo} ${e.caminho}`));
	const deletes = Object.entries(spec.paths).filter(([, ops]) => ops.delete).map(([caminho]) => `DELETE ${caminho}`);
	assert.ok(deletes.length > 0, "o documento real não tem nenhum DELETE: algo está errado na leitura");
	const fora = deletes.filter((d) => !listados.has(d));
	assert.deepEqual(fora, [], `DELETE novo fora de mcp/src/irreversiveis.ts: ${fora.join(", ")}`);
	assert.ok(METODOS.includes("delete"));
});

test("DELETE fora da lista também é tratado como irreversível (rota nova chega pelo documento antes da lista)", () => {
	assert.ok(acharIrreversivel({ metodo: "DELETE", caminho: "/api/coisa-nova/1", modelo: "/api/coisa-nova/{id}" }));
	assert.equal(acharIrreversivel({ metodo: "GET", caminho: "/api/contacts", modelo: "/api/contacts" }), undefined);
});

test("operação que depende do corpo: transmissão só em rascunho passa, envio ou agendamento é irreversível", () => {
	const p = (corpo: unknown) => ({ metodo: "POST" as const, caminho: "/api/broadcasts", modelo: "/api/broadcasts", corpo });
	assert.equal(acharIrreversivel(p({ name: "x", status: "draft" })), undefined);
	assert.ok(acharIrreversivel(p({ name: "x", status: "sending" })));
	assert.ok(acharIrreversivel(p({ name: "x", status: "scheduled" })));
	assert.ok(acharIrreversivel(p({ name: "x" })), "sem status: bloqueia (o caminho mais seguro)");
	assert.ok(acharIrreversivel(p("texto que não é JSON")));
	// corpo cru com JSON (rawBody) é lido do mesmo jeito que o motor lê
	assert.equal(acharIrreversivel(p(JSON.stringify({ status: "draft" }))), undefined);
	assert.ok(acharIrreversivel(p(JSON.stringify({ status: "sending" }))));
});

test("limpeza da lista só é irreversível quando aplica exclusão ou descadastro", () => {
	const p = (corpo: unknown) => ({ metodo: "POST" as const, caminho: "/api/contacts/cleanup", modelo: "/api/contacts/cleanup", corpo });
	assert.equal(acharIrreversivel(p({ inactive_days: 90, action: "delete" })), undefined, "sem apply só conta");
	assert.equal(acharIrreversivel(p({ inactive_days: 90, action: "tag", tag_id: "t", apply: true })), undefined);
	assert.ok(acharIrreversivel(p({ inactive_days: 90, action: "delete", apply: true })));
	assert.ok(acharIrreversivel(p({ inactive_days: 90, action: "unsubscribe", apply: true })));
});

test("ligar conexão passa, desligar é irreversível", () => {
	const p = (corpo: unknown) => ({ metodo: "POST" as const, caminho: "/api/connections/c1/enabled", modelo: "/api/connections/{id}/enabled", corpo });
	assert.equal(acharIrreversivel(p({ enabled: true })), undefined);
	assert.ok(acharIrreversivel(p({ enabled: false })));
	assert.ok(acharIrreversivel(p({})));
});

// ---- na função de pedido, com motor falso ----

const recorte: DocumentoApi = {
	openapi: "3.1.0",
	info: { title: "ManyCraft", version: "1" },
	paths: {
		"/api/tags": { get: {}, post: {} },
		"/api/tags/{id}": { patch: {}, delete: {} },
		"/api/broadcasts": { get: {}, post: {} },
		"/api/inbox/conversations/{id}/messages": { get: {}, post: {} },
	},
};

function montar(liberado: boolean) {
	const chamadas: { url: string; init: RequestInit }[] = [];
	const engine = { fetch: async (url: string, init: RequestInit) => { chamadas.push({ url, init }); return Response.json({ ok: true }); } };
	const pedir = criarFuncaoDePedido({
		engine: engine as unknown as Fetcher,
		documento: prepararDocumento(recorte),
		authorization: "Bearer perfil:k",
		workspace: "w",
		registrar: () => {},
		ganchos: { antesDoPedido: travaDeIrreversiveis(liberado) },
	});
	return { pedir, chamadas };
}

test("irreversível sem o cabeçalho: recusa com a mensagem exata e não chama o motor", async () => {
	const { pedir, chamadas } = montar(false);
	for (const pedido of [
		{ method: "DELETE" as const, path: "/api/tags/t1" },
		{ method: "POST" as const, path: "/api/inbox/conversations/c1/messages", body: { text: "oi" } },
		{ method: "POST" as const, path: "/api/broadcasts", body: { name: "x", status: "sending" } },
	]) {
		await assert.rejects(pedir(pedido), (e: Error) => { assert.equal(e.message, MENSAGEM_BLOQUEIO); return true; });
	}
	assert.equal(chamadas.length, 0);
});

test("irreversível com o cabeçalho liberado: vai ao motor", async () => {
	const { pedir, chamadas } = montar(true);
	await pedir({ method: "DELETE", path: "/api/tags/t1" });
	await pedir({ method: "POST", path: "/api/inbox/conversations/c1/messages", body: { text: "oi" } });
	assert.deepEqual(chamadas.map((c) => c.init.method), ["DELETE", "POST"]);
});

test("operação fora da lista passa sem o cabeçalho", async () => {
	const { pedir, chamadas } = montar(false);
	await pedir({ method: "GET", path: "/api/tags" });
	await pedir({ method: "POST", path: "/api/tags", body: { name: "nova" } });
	await pedir({ method: "PATCH", path: "/api/tags/t1", body: { name: "outra" } });
	await pedir({ method: "POST", path: "/api/broadcasts", body: { name: "x", status: "draft" } });
	assert.equal(chamadas.length, 4);
});

test("o código do modelo não consegue mandar o cabeçalho de liberação", async () => {
	const { pedir, chamadas } = montar(false);
	// RequestOptions não tem campo de cabeçalhos; mesmo que o modelo invente um, ou ponha na query, a trava não lê o pedido.
	const tentativas = [
		{ method: "DELETE", path: "/api/tags/t1", headers: { "x-manycraft-irreversiveis": "permitir" } },
		{ method: "DELETE", path: "/api/tags/t1", query: { "x-manycraft-irreversiveis": "permitir" } },
		{ method: "DELETE", path: "/api/tags/t1", body: { "x-manycraft-irreversiveis": "permitir" } },
	];
	for (const t of tentativas) await assert.rejects(pedir(t as never), (e: Error) => e.message === MENSAGEM_BLOQUEIO);
	assert.equal(chamadas.length, 0);

	// E o cabeçalho nunca é repassado ao motor, nem com a trava liberada.
	const liberado = montar(true);
	await liberado.pedir({ method: "DELETE", path: "/api/tags/t1", headers: { "x-manycraft-irreversiveis": "permitir" } } as never);
	const h = new Headers(liberado.chamadas[0].init.headers);
	assert.equal(h.get("x-manycraft-irreversiveis"), null);
});
