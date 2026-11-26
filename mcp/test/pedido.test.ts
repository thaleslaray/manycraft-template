// Função de pedido com motor falso (um objeto com fetch). Roda com `node --test` (Node tira os tipos sozinho).
import assert from "node:assert/strict";
import { test } from "node:test";
import { prepararDocumento, type DocumentoApi } from "../src/documento.ts";
import { criarFuncaoDePedido, PedidoRecusado } from "../src/pedido.ts";

const CHAVE = "perfil:chave-secreta-de-teste-123";
const AUTH = `Bearer ${CHAVE}`;
const ESPACO = "espaco-secreto-456";

// Recorte fixo no formato do documento real: duas áreas comuns e uma rota da tag congelada.
const recorte: DocumentoApi = {
	openapi: "3.1.0",
	info: { title: "ManyCraft", version: "1" },
	paths: {
		"/api/contacts": { get: { tags: ["Contatos"] }, post: { tags: ["Contatos"] } },
		"/api/contacts/{id}": { get: { tags: ["Contatos"] }, patch: { tags: ["Contatos"] }, delete: { tags: ["Contatos"] } },
		"/api/contacts/search": { post: { tags: ["Contatos"] } },
		"/api/tags": { get: { tags: ["Tags"] } },
		"/api/public/v1/page/getInfo": { get: { tags: ["Formato ManyChat (congelada)"] } },
	},
};

type Chamada = { url: string; init: RequestInit & { headers: Headers } };
function motorFalso(resposta: () => Response = () => Response.json({ rows: [], next_cursor: null })) {
	const chamadas: Chamada[] = [];
	return {
		chamadas,
		fetch: async (url: string, init: RequestInit) => {
			chamadas.push({ url, init: { ...init, headers: new Headers(init.headers) } });
			return resposta();
		},
	};
}

function montar(motor = motorFalso()) {
	const linhas: string[] = [];
	const pedir = criarFuncaoDePedido({
		engine: motor as unknown as Fetcher,
		documento: prepararDocumento(recorte),
		authorization: AUTH,
		workspace: ESPACO,
		registrar: (l) => linhas.push(l),
	});
	return { pedir, motor, linhas };
}

test("caminho fora do documento é recusado sem chamar o motor", async () => {
	const { pedir, motor } = montar();
	await assert.rejects(pedir({ method: "GET", path: "/api/nao-existe" }), /não está no documento da API/);
	await assert.rejects(pedir({ method: "GET", path: "/health" }), /precisa começar com \/api\//);
	await assert.rejects(pedir({ method: "GET", path: "/api/contacts/../tags" }), PedidoRecusado);
	await assert.rejects(pedir({ method: "GET", path: "/api/contacts?limit=5" }), /query/);
	await assert.rejects(pedir({ method: "GET", path: "/api/contacts/%2e%2e" }), PedidoRecusado);
	assert.equal(motor.chamadas.length, 0);
});

test("rota do formato ManyChat (congelada) é recusada sem chamar o motor", async () => {
	const { pedir, motor } = montar();
	await assert.rejects(pedir({ method: "GET", path: "/api/public/v1/page/getInfo" }), /não está no documento da API/);
	assert.equal(motor.chamadas.length, 0);
});

test("método que o documento não define para o caminho é recusado sem chamar o motor", async () => {
	const { pedir, motor } = montar();
	await assert.rejects(pedir({ method: "DELETE", path: "/api/tags" }), /DELETE não existe para \/api\/tags \(o documento define GET\)/);
	await assert.rejects(pedir({ method: "PUT", path: "/api/contacts/123" }), /PUT não existe/);
	assert.equal(motor.chamadas.length, 0);
});

test("aceita qualquer método do documento e prefere o caminho literal ao com parâmetro", async () => {
	const { pedir, motor, linhas } = montar();
	await pedir({ method: "POST", path: "/api/contacts/search", body: { q: "ana" } });
	await pedir({ method: "PATCH", path: "/api/contacts/123", body: { name: "Ana" } });
	await pedir({ method: "DELETE", path: "/api/contacts/123" });
	assert.deepEqual(motor.chamadas.map((c) => c.init.method), ["POST", "PATCH", "DELETE"]);
	assert.deepEqual(linhas.map((l) => JSON.parse(l).caminho), ["/api/contacts/search", "/api/contacts/<id>", "/api/contacts/<id>"]);
});

test("os dois cabeçalhos chegam ao motor e não aparecem no retorno", async () => {
	const { pedir, motor } = montar();
	const retorno = await pedir({ method: "GET", path: "/api/contacts" });
	const h = motor.chamadas[0].init.headers;
	assert.equal(h.get("authorization"), AUTH);
	assert.equal(h.get("x-workspace"), ESPACO);
	const texto = JSON.stringify(retorno);
	assert.ok(!texto.includes(CHAVE) && !texto.includes(ESPACO));
});

test("a chave não volta ao modelo nem se o motor a repetir na resposta", async () => {
	const { pedir } = montar(motorFalso(() => Response.json({ eco: CHAVE })));
	const retorno = await pedir({ method: "GET", path: "/api/contacts" });
	assert.ok(!JSON.stringify(retorno).includes(CHAVE));
});

test("query e body chegam ao motor", async () => {
	const { pedir, motor } = montar();
	await pedir({ method: "GET", path: "/api/contacts", query: { cursor: "abc", tag: "vip", vazio: undefined } });
	await pedir({ method: "POST", path: "/api/contacts", body: { name: "Ana", tags: ["vip"] } });
	const url = new URL(motor.chamadas[0].url);
	assert.equal(url.pathname, "/api/contacts");
	assert.equal(url.searchParams.get("cursor"), "abc");
	assert.equal(url.searchParams.get("tag"), "vip");
	assert.equal(url.searchParams.has("vazio"), false);
	const post = motor.chamadas[1].init;
	assert.equal(post.headers.get("content-type"), "application/json");
	assert.deepEqual(JSON.parse(String(post.body)), { name: "Ana", tags: ["vip"] });
});

test("erro do motor chega com status e mensagem, sem chave nem espaço", async () => {
	const { pedir } = montar(motorFalso(() => Response.json({ error: "Esta ação só pode ser feita no painel." }, { status: 403 })));
	await assert.rejects(pedir({ method: "GET", path: "/api/contacts" }), (e: Error) => {
		assert.equal(e.message, "API respondeu 403: Esta ação só pode ser feita no painel.");
		return true;
	});

	const eco = montar(motorFalso(() => Response.json({ error: `Espaço ${ESPACO} sem acesso para ${CHAVE}` }, { status: 401 })));
	await assert.rejects(eco.pedir({ method: "GET", path: "/api/contacts" }), (e: Error) => {
		assert.match(e.message, /^API respondeu 401: /);
		assert.ok(!e.message.includes(CHAVE) && !e.message.includes(ESPACO));
		return true;
	});
});

test("erro de validação leva os detalhes do motor", async () => {
	const { pedir } = montar(motorFalso(() => Response.json({ error: "Dados inválidos", details: { name: "obrigatório" } }, { status: 400 })));
	await assert.rejects(pedir({ method: "POST", path: "/api/contacts", body: {} }), /API respondeu 400: Dados inválidos \{"name":"obrigatório"\}/);
});

test("a linha de registro não tem query, corpo, chave nem espaço", async () => {
	const { pedir, linhas } = montar();
	await pedir({ method: "GET", path: "/api/contacts/contato-789", query: { busca: "termo-da-query" } });
	await pedir({ method: "POST", path: "/api/contacts", body: { name: "corpo-do-pedido" } });
	assert.equal(linhas.length, 2);
	for (const linha of linhas) {
		for (const proibido of ["termo-da-query", "busca", "corpo-do-pedido", "contato-789", CHAVE, ESPACO]) {
			assert.ok(!linha.includes(proibido), `linha de registro com "${proibido}": ${linha}`);
		}
	}
	const primeira = JSON.parse(linhas[0]);
	assert.deepEqual(Object.keys(primeira).sort(), ["caminho", "evento", "metodo", "ms", "status"]);
	assert.deepEqual({ metodo: primeira.metodo, caminho: primeira.caminho, status: primeira.status }, { metodo: "GET", caminho: "/api/contacts/<id>", status: 200 });
});

test("gancho antesDoPedido recebe o pedido conferido e pode recusar sem chamar o motor (encaixe da ficha 03)", async () => {
	const motor = motorFalso();
	const vistos: unknown[] = [];
	const pedir = criarFuncaoDePedido({
		engine: motor as unknown as Fetcher,
		documento: prepararDocumento(recorte),
		authorization: AUTH,
		workspace: ESPACO,
		registrar: () => {},
		ganchos: {
			antesDoPedido: (p) => {
				vistos.push(p);
				if (p.metodo === "DELETE") throw new Error("bloqueado pelo gancho");
			},
		},
	});
	await pedir({ method: "GET", path: "/api/contacts/1" });
	await assert.rejects(pedir({ method: "DELETE", path: "/api/contacts/1" }), /bloqueado pelo gancho/);
	assert.deepEqual(vistos, [
		{ metodo: "GET", caminho: "/api/contacts/1", modelo: "/api/contacts/{id}" },
		{ metodo: "DELETE", caminho: "/api/contacts/1", modelo: "/api/contacts/{id}" },
	]);
	assert.equal(motor.chamadas.length, 1);
});
