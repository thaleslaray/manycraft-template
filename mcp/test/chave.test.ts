// Chave de perfil conferida no motor antes de criar o servidor MCP: só o 401 recusa, e o resultado fica guardado.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { chaveAceita, esquecerChaves, VALIDADE_MS } from "../src/chave.ts";

const motor = (status: number | Error) => {
	const pedidos: { url: string; headers: Record<string, string> }[] = [];
	return {
		pedidos,
		async fetch(url: string, init?: RequestInit) {
			pedidos.push({ url, headers: init?.headers as Record<string, string> });
			if (status instanceof Error) throw status;
			return new Response("{}", { status });
		},
	};
};
const base = { authorization: "Bearer perfil:abc", workspace: "w" };

beforeEach(esquecerChaves);

test("401 do motor recusa a chave; o pedido leva a chave e o espaço", async () => {
	const engine = motor(401);
	assert.equal(await chaveAceita({ engine, ...base }), false);
	assert.deepEqual(engine.pedidos, [{ url: "https://engine/api/tags", headers: { authorization: "Bearer perfil:abc", "x-workspace": "w" } }]);
});

test("200, 403 e 500 deixam passar; motor fora do ar também", async () => {
	for (const s of [200, 403, 500, new Error("fora do ar")]) {
		esquecerChaves();
		assert.equal(await chaveAceita({ engine: motor(s), ...base }), true, String(s));
	}
});

test("o resultado vale por 5 minutos e é por chave e por espaço", async () => {
	const engine = motor(401);
	let t = 1_000;
	const o = { engine, ...base, agora: () => t };
	await chaveAceita(o);
	await chaveAceita(o);
	assert.equal(engine.pedidos.length, 1);
	await chaveAceita({ ...o, workspace: "outro" });
	await chaveAceita({ ...o, authorization: "Bearer perfil:outra" });
	assert.equal(engine.pedidos.length, 3);
	t += VALIDADE_MS + 1;
	await chaveAceita(o);
	assert.equal(engine.pedidos.length, 4);
});

test("o cache compartilhado evita o motor e nunca guarda a chave", async () => {
	const guardado = new Map<string, string>();
	const cache = {
		async match(k: string) { return guardado.has(k) ? new Response(guardado.get(k)) : undefined; },
		async put(k: string, r: Response) { guardado.set(k, await r.text()); },
	};
	const engine = motor(401);
	assert.equal(await chaveAceita({ engine, cache, ...base }), false);
	esquecerChaves();
	assert.equal(await chaveAceita({ engine, cache, ...base }), false);
	assert.equal(engine.pedidos.length, 1);
	const tudo = [...guardado.entries()].flat().join(" ");
	assert.doesNotMatch(tudo, /abc/);
	assert.match(tudo, /\/chave\/[0-9a-f]{64} 0$/);
});
