// Entrada: 404 fora de /mcp, 401 sem chave de perfil, 400 sem x-workspace, antes de criar o servidor MCP.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TEXTO_EXECUTE } from "../src/descricao.ts";
import { conferirEntrada } from "../src/entrada.ts";

const pedido = (caminho: string, headers: Record<string, string> = {}) => new Request(`https://mcp.exemplo${caminho}`, { method: "POST", headers });

test("só /mcp", async () => {
	const r = conferirEntrada(pedido("/outra", { authorization: "Bearer perfil:x", "x-workspace": "w" }));
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.resposta.status, 404);
});

test("405 para GET e DELETE, com Allow: POST", () => {
	for (const method of ["GET", "DELETE"]) {
		const r = conferirEntrada(new Request("https://mcp.exemplo/mcp", { method, headers: { authorization: "Bearer perfil:x", "x-workspace": "w" } }));
		assert.equal(r.ok, false, method);
		if (!r.ok) {
			assert.equal(r.resposta.status, 405);
			assert.equal(r.resposta.headers.get("allow"), "POST");
		}
	}
});

test("401 sem authorization ou fora do formato Bearer <chave>", async () => {
	for (const auth of [undefined, "perfil:abc", "Bearer perfil:", "Bearer", "Basic perfil:abc", "Bearer a b"]) {
		const r = conferirEntrada(pedido("/mcp", { ...(auth ? { authorization: auth } : {}), "x-workspace": "w" }));
		assert.equal(r.ok, false, String(auth));
		if (!r.ok) {
			assert.equal(r.resposta.status, 401);
			assert.match(((await r.resposta.json()) as { error: string }).error, /Bearer <chave>/);
		}
	}
});

test("400 sem x-workspace, dizendo qual cabeçalho falta", async () => {
	const r = conferirEntrada(pedido("/mcp", { authorization: "Bearer perfil:abc" }));
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.equal(r.resposta.status, 400);
		assert.match(((await r.resposta.json()) as { error: string }).error, /x-workspace/);
	}
});

test("com os dois cabeçalhos, segue com eles", () => {
	const r = conferirEntrada(pedido("/mcp", { authorization: "Bearer perfil:abc", "x-workspace": "demo-workspace" }));
	assert.deepEqual(r, { ok: true, authorization: "Bearer perfil:abc", workspace: "demo-workspace", irreversiveisLiberados: false });
});

test("x-manycraft-irreversiveis: só 'permitir' libera (sem diferenciar maiúsculas)", () => {
	const base = { authorization: "Bearer perfil:abc", "x-workspace": "w" };
	const liberado = (valor?: string) => {
		const r = conferirEntrada(pedido("/mcp", valor === undefined ? base : { ...base, "x-manycraft-irreversiveis": valor }));
		assert.equal(r.ok, true);
		return r.ok && r.irreversiveisLiberados;
	};
	assert.equal(liberado("permitir"), true);
	assert.equal(liberado("PERMITIR"), true);
	assert.equal(liberado("Permitir"), true);
	for (const outro of [undefined, "", "sim", "true", "1", "permitido", "permitir,permitir", "não permitir"]) {
		assert.equal(liberado(outro), false, String(outro));
	}
});

test("texto de execute avisa da trava de irreversíveis", () => {
	assert.match(TEXTO_EXECUTE, /irreversíve/);
	assert.match(TEXTO_EXECUTE, /dono/);
	assert.match(TEXTO_EXECUTE, /não tente contornar/i);
});

test("texto extra de execute em português cobre as regras combinadas", () => {
	for (const trecho of ["search antes", "formato", "só os campos", "403", "next_cursor", "/api/contacts", "40 contatos"]) {
		assert.ok(TEXTO_EXECUTE.includes(trecho), trecho);
	}
});

test("a chave vale com ou sem o prefixo perfil:, e segue para o motor sempre com um só", () => {
	for (const auth of ["Bearer abc", "Bearer perfil:abc", "Bearer perfil:perfil:abc", "bearer  abc"]) {
		const r = conferirEntrada(pedido("/mcp", { authorization: auth, "x-workspace": "w" }));
		assert.equal(r.ok && r.authorization, "Bearer perfil:abc", auth);
	}
});
