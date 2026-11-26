// Conectar por login (ficha 07): o pacote de autorização de verdade em volta de um MCP falso, com KV e motor em memória.
// Cobre /authorize, /pedido, /callback (vencido, reusado, chave recusada, espaço alheio, recusa), a troca do código com
// PKCE, a renovação com a chave revogada e o caminho antigo dos cabeçalhos.
import { kvFalso, MCP_URL, motorFalso, PAINEL_URL, pkce } from "./oauth-falso.ts";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { esquecerChaves } from "../src/chave.ts";

const { criarWorker, PREFIXO_PEDIDO } = await import("../src/provedor.ts");

const SEGREDO = "segredo-de-teste-7f3a9c";
const ESPACO = "espaco-de-teste-91";
const RETORNO = "http://127.0.0.1:9999/volta";

let recebidos: unknown[] = [];
const worker = criarWorker({
	fetch(_request: Request, _env: unknown, ctx: ExecutionContext & { props?: unknown }) {
		recebidos.push(ctx.props);
		return Response.json({ ok: true });
	},
});

function montar() {
	const kv = kvFalso();
	const motor = motorFalso({ [SEGREDO]: [ESPACO] });
	const env = { ENGINE: motor, OAUTH_KV: kv, MCP_URL, PAINEL_URL } as never;
	const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
	const chamar = (caminho: string, init?: RequestInit) => worker.fetch!(new Request(`${MCP_URL}${caminho}`, init) as never, env, ctx);
	return { kv, motor, chamar };
}

const formulario = (campos: Record<string, string>, origem = PAINEL_URL) => ({
	method: "POST",
	body: new URLSearchParams(campos),
	headers: { origin: origem, "content-type": "application/x-www-form-urlencoded" },
});

/** Registra um cliente, abre /authorize com PKCE e devolve o id do pedido que foi para o painel. */
async function iniciar(a: ReturnType<typeof montar>) {
	const reg = await a.chamar("/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ redirect_uris: [RETORNO], client_name: "Cliente de teste", token_endpoint_auth_method: "none" }),
	});
	assert.equal(reg.status, 201);
	const { client_id } = (await reg.json()) as { client_id: string };
	const { verificador, desafio } = await pkce();
	const q = new URLSearchParams({
		response_type: "code", client_id, redirect_uri: RETORNO, state: "estado-xyz",
		code_challenge: desafio, code_challenge_method: "S256", resource: `${MCP_URL}/mcp`,
	});
	const aut = await a.chamar(`/authorize?${q}`);
	assert.equal(aut.status, 302);
	const destino = new URL(aut.headers.get("location")!);
	assert.equal(`${destino.origin}${destino.pathname}`, `${PAINEL_URL}/conectar`);
	const pedido = destino.searchParams.get("pedido")!;
	return { client_id, verificador, desafio, pedido, destino };
}

async function aprovar(a: ReturnType<typeof montar>, pedido: string, extra: Record<string, string> = {}) {
	return a.chamar("/callback", formulario({ pedido, decisao: "aprovar", token: `perfil:${SEGREDO}`, workspace: ESPACO, ...extra }));
}

async function trocar(a: ReturnType<typeof montar>, campos: Record<string, string>) {
	return a.chamar("/token", { method: "POST", body: new URLSearchParams(campos), headers: { "content-type": "application/x-www-form-urlencoded" } });
}

/** A volta ao cliente é uma página que redireciona sozinha (nunca 302: a regra form-action do painel barraria). */
async function destinoDaVolta(r: Response): Promise<URL> {
	assert.equal(r.status, 200);
	assert.equal(r.headers.get("location"), null);
	const m = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(await r.text());
	assert.ok(m, "página de volta sem o redirecionamento");
	return new URL(m[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))));
}

/** Fluxo inteiro até os tokens. */
async function conectar(a: ReturnType<typeof montar>, extra: Record<string, string> = {}) {
	const ini = await iniciar(a);
	const cb = await aprovar(a, ini.pedido, extra);
	const volta = await destinoDaVolta(cb);
	const tok = await trocar(a, { grant_type: "authorization_code", code: volta.searchParams.get("code")!, redirect_uri: RETORNO, client_id: ini.client_id, code_verifier: ini.verificador });
	assert.equal(tok.status, 200);
	return { ...ini, volta, tokens: (await tok.json()) as { access_token: string; refresh_token: string } };
}

beforeEach(() => {
	recebidos = [];
	esquecerChaves();
});

// ---------- caminho antigo, pelos cabeçalhos ----------

test("cabeçalhos: sem authorization → 401 em português, com o desafio que aponta os metadados", async () => {
	const r = await montar().chamar("/mcp", { method: "POST" });
	assert.equal(r.status, 401);
	assert.match(r.headers.get("www-authenticate") ?? "", new RegExp(`resource_metadata="${MCP_URL}/\\.well-known/oauth-protected-resource/mcp"`));
	assert.match(((await r.json()) as { error: string }).error, /Bearer <chave>/);
});

test("cabeçalhos: authorization fora do formato → 401 com a mesma mensagem", async () => {
	for (const auth of ["perfil:abc", "Bearer", "Basic perfil:abc", "Bearer a b", "Bearer perfil:"]) {
		const r = await montar().chamar("/mcp", { method: "POST", headers: { authorization: auth, "x-workspace": "w" } });
		assert.equal(r.status, 401, auth);
		assert.match(((await r.json()) as { error: string }).error, /Bearer <chave>/, auth);
	}
});

test("cabeçalhos: GET e DELETE em /mcp → 405 com Allow: POST; outro caminho → 404", async () => {
	for (const method of ["GET", "DELETE"]) {
		const r = await montar().chamar("/mcp", { method, headers: { authorization: `Bearer perfil:${SEGREDO}`, "x-workspace": ESPACO } });
		assert.equal(r.status, 405, method);
		assert.equal(r.headers.get("allow"), "POST");
	}
	const r = await montar().chamar("/outra", { method: "POST" });
	assert.equal(r.status, 404);
	assert.match(((await r.json()) as { error: string }).error, /responde em \/mcp/);
});

test("cabeçalhos: sem x-workspace → 400 dizendo qual cabeçalho falta", async () => {
	const r = await montar().chamar("/mcp", { method: "POST", headers: { authorization: `Bearer perfil:${SEGREDO}` } });
	assert.equal(r.status, 400);
	assert.match(((await r.json()) as { error: string }).error, /x-workspace/);
});

test("cabeçalhos: chave que o motor recusa → 401 'Chave inválida ou revogada'", async () => {
	const r = await montar().chamar("/mcp", { method: "POST", headers: { authorization: "Bearer perfil:inventada", "x-workspace": ESPACO } });
	assert.equal(r.status, 401);
	assert.match(((await r.json()) as { error: string }).error, /Chave inválida ou revogada/);
	assert.ok(r.headers.get("www-authenticate"));
});

test("cabeçalhos: chave com ou sem perfil:, espaço e irreversíveis chegam ao MCP como antes", async () => {
	for (const [auth, irr, liberado] of [[`Bearer ${SEGREDO}`, undefined, false], [`Bearer perfil:${SEGREDO}`, "Permitir", true]] as const) {
		recebidos = [];
		const headers: Record<string, string> = { authorization: auth, "x-workspace": ESPACO };
		if (irr) headers["x-manycraft-irreversiveis"] = irr;
		const r = await montar().chamar("/mcp", { method: "POST", headers });
		assert.equal(r.status, 200, auth);
		assert.deepEqual(recebidos, [{ authorization: `Bearer perfil:${SEGREDO}`, workspace: ESPACO, irreversiveisLiberados: liberado }]);
	}
});

// ---------- descoberta ----------

test("metadados do recurso e do servidor de autorização, com registro dinâmico", async () => {
	const a = montar();
	const recurso = (await (await a.chamar("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
	assert.equal(recurso.resource, `${MCP_URL}/mcp`);
	const as = (await (await a.chamar("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
	assert.equal(as.authorization_endpoint, `${MCP_URL}/authorize`);
	assert.equal(as.token_endpoint, `${MCP_URL}/token`);
	assert.equal(as.registration_endpoint, `${MCP_URL}/register`);
});

// ---------- /authorize e /pedido ----------

test("/authorize guarda o pedido por 10 minutos sob um id de 256 bits e manda para o painel só com esse id", async () => {
	const a = montar();
	const { pedido, destino, desafio } = await iniciar(a);
	assert.match(pedido, /^[0-9a-f]{64}$/);
	assert.deepEqual([...destino.searchParams.keys()], ["pedido"]);
	const guardado = a.kv.dados.get(`${PREFIXO_PEDIDO}${pedido}`)!;
	assert.ok(guardado);
	const restante = (guardado.expira! - Date.now()) / 1000;
	assert.ok(restante > 590 && restante <= 600, String(restante));
	assert.ok(guardado.valor.includes(desafio));
});

test("/authorize com cliente desconhecido mostra página em português e não redireciona", async () => {
	const r = await montar().chamar(`/authorize?${new URLSearchParams({ response_type: "code", client_id: "nao-existe", redirect_uri: RETORNO, state: "s" })}`);
	assert.equal(r.status, 400);
	assert.equal(r.headers.get("location"), null);
	assert.match(r.headers.get("content-type") ?? "", /text\/html/);
	assert.match(await r.text(), /pedido de conexão/i);
});

test("/pedido/<id> devolve só o nome do cliente e o destino, com CORS só para o painel", async () => {
	const a = montar();
	const { pedido, desafio } = await iniciar(a);
	const r = await a.chamar(`/pedido/${pedido}`, { headers: { origin: PAINEL_URL } });
	assert.equal(r.status, 200);
	assert.equal(r.headers.get("access-control-allow-origin"), PAINEL_URL);
	const corpo = await r.text();
	assert.deepEqual(JSON.parse(corpo), { cliente: "Cliente de teste", destino: "127.0.0.1", local: true });
	assert.ok(!corpo.includes(desafio) && !corpo.includes("estado-xyz"));
	// Ler não consome o pedido.
	assert.equal((await a.chamar(`/pedido/${pedido}`)).status, 200);
});

test("/pedido/<id> desconhecido ou fora do formato → 404", async () => {
	const a = montar();
	for (const id of ["0".repeat(64), "curto", "G".repeat(64)]) {
		const r = await a.chamar(`/pedido/${id}`, { headers: { origin: PAINEL_URL } });
		assert.equal(r.status, 404, id);
		assert.equal(r.headers.get("access-control-allow-origin"), PAINEL_URL);
	}
});

// ---------- /callback ----------

test("fluxo completo: /callback confere chave e espaço, troca do código com PKCE e o MCP recebe os props", async () => {
	const a = montar();
	const { volta, tokens } = await conectar(a, { irreversiveis: "permitir" });
	assert.equal(volta.origin + volta.pathname, RETORNO);
	assert.equal(volta.searchParams.get("state"), "estado-xyz");
	assert.ok(tokens.refresh_token);
	// O motor foi consultado com os dois cabeçalhos.
	assert.deepEqual(a.motor.pedidos.at(-1), { url: "https://engine/api/tags", authorization: `Bearer perfil:${SEGREDO}`, workspace: ESPACO });

	const r = await a.chamar("/mcp", { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` } });
	assert.equal(r.status, 200);
	assert.deepEqual(recebidos, [{ authorization: `Bearer perfil:${SEGREDO}`, workspace: ESPACO, irreversiveisLiberados: true }]);

	// Nada no KV em claro: nem a chave, nem o espaço; o pedido já foi apagado.
	const tudo = JSON.stringify([...a.kv.dados.entries()]);
	assert.ok(!tudo.includes(SEGREDO), "chave no KV");
	assert.ok(!tudo.includes(ESPACO), "espaço no KV");
	assert.ok(![...a.kv.dados.keys()].some((k) => k.startsWith(PREFIXO_PEDIDO)));
});

test("irreversíveis só com 'permitir'; sem o campo ficam travadas", async () => {
	const a = montar();
	const { tokens } = await conectar(a);
	await a.chamar("/mcp", { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` } });
	assert.deepEqual(recebidos, [{ authorization: `Bearer perfil:${SEGREDO}`, workspace: ESPACO, irreversiveisLiberados: false }]);
});

test("/callback: pedido reusado não vale de novo", async () => {
	const a = montar();
	const { pedido } = await iniciar(a);
	await destinoDaVolta(await aprovar(a, pedido));
	const r = await aprovar(a, pedido);
	assert.equal(r.status, 400);
	assert.match(await r.text(), /venceu ou já foi usado/);
});

test("/callback: pedido vencido não vale", async () => {
	const a = montar();
	const { pedido } = await iniciar(a);
	a.kv.vencer(`${PREFIXO_PEDIDO}${pedido}`);
	const r = await aprovar(a, pedido);
	assert.equal(r.status, 400);
	assert.equal(r.headers.get("location"), null);
	assert.match(await r.text(), /venceu ou já foi usado/);
});

test("/callback: chave recusada pelo motor mostra a página de erro e consome o pedido", async () => {
	const a = montar();
	const { pedido } = await iniciar(a);
	const r = await aprovar(a, pedido, { token: "perfil:inventada" });
	assert.equal(r.status, 400);
	assert.equal(r.headers.get("location"), null);
	assert.match(await r.text(), /chave foi recusada/);
	assert.equal((await aprovar(a, pedido)).status, 400);
});

test("/callback: espaço em que a pessoa não é membro é recusado", async () => {
	const a = montar();
	const { pedido } = await iniciar(a);
	const r = await aprovar(a, pedido, { workspace: "espaco-de-outra-pessoa" });
	assert.equal(r.status, 400);
	assert.match(await r.text(), /não participa desse espaço/);
});

test("/callback: motor fora do ar → 503, sem completar", async () => {
	const a = montar();
	const { pedido } = await iniciar(a);
	a.motor.derrubar();
	const r = await aprovar(a, pedido);
	assert.equal(r.status, 503);
	assert.equal(r.headers.get("location"), null);
});

test("/callback: cancelar volta ao cliente com error=access_denied e o state", async () => {
	const a = montar();
	const { pedido } = await iniciar(a);
	const r = await a.chamar("/callback", formulario({ pedido, decisao: "negar" }));
	const volta = await destinoDaVolta(r);
	assert.equal(volta.origin + volta.pathname, RETORNO);
	assert.equal(volta.searchParams.get("error"), "access_denied");
	assert.equal(volta.searchParams.get("state"), "estado-xyz");
	assert.equal(volta.searchParams.get("code"), null);
});

test("/callback: formulário vindo de outro site é recusado sem consumir o pedido", async () => {
	const a = montar();
	const { pedido } = await iniciar(a);
	const r = await a.chamar("/callback", formulario({ pedido, decisao: "aprovar", token: `perfil:${SEGREDO}`, workspace: ESPACO }, "https://site-malicioso.exemplo"));
	assert.equal(r.status, 403);
	await destinoDaVolta(await aprovar(a, pedido));
});

test("/callback: só POST", async () => {
	const r = await montar().chamar("/callback");
	assert.equal(r.status, 405);
});

// ---------- renovação e revogação ----------

test("renovação: com a chave ativa renova; revogada → invalid_grant", async () => {
	const a = montar();
	const { client_id, tokens } = await conectar(a);
	const ok = await trocar(a, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id });
	assert.equal(ok.status, 200);
	const novo = (await ok.json()) as { refresh_token: string; access_token: string };

	delete a.motor.chaves[SEGREDO];
	const r = await trocar(a, { grant_type: "refresh_token", refresh_token: novo.refresh_token, client_id });
	assert.equal(r.status, 400);
	assert.equal(((await r.json()) as { error: string }).error, "invalid_grant");
	// O grant foi revogado junto: o token de acesso deixa de valer.
	const mcp = await a.chamar("/mcp", { method: "POST", headers: { authorization: `Bearer ${novo.access_token}` } });
	assert.equal(mcp.status, 401);
});

test("renovação: motor fora do ar → temporarily_unavailable, sem revogar", async () => {
	const a = montar();
	const { client_id, tokens } = await conectar(a);
	a.motor.derrubar();
	const r = await trocar(a, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id });
	assert.equal(((await r.json()) as { error: string }).error, "temporarily_unavailable");
	a.motor.derrubar(false);
	assert.equal((await trocar(a, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id })).status, 200);
});

test("token do login com a chave revogada → 401 com o desafio, sem chegar ao MCP", async () => {
	const a = montar();
	const { tokens } = await conectar(a);
	delete a.motor.chaves[SEGREDO];
	esquecerChaves();
	const r = await a.chamar("/mcp", { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` } });
	assert.equal(r.status, 401);
	assert.match(r.headers.get("www-authenticate") ?? "", /invalid_token/);
	assert.match(((await r.json()) as { error: string }).error, /Chave inválida ou revogada/);
	assert.deepEqual(recebidos, []);
});

// ---------- registro ----------

test("o registro nunca leva a chave, o token, o código nem o espaço", async () => {
	const linhas: string[] = [];
	const originais = { log: console.log, warn: console.warn, error: console.error, info: console.info };
	for (const nome of ["log", "warn", "error", "info"] as const) console[nome] = (...args: unknown[]) => { linhas.push(args.map(String).join(" ")); };
	let segredos: string[] = [];
	try {
		const a = montar();
		const { tokens, volta, client_id } = await conectar(a);
		segredos = [SEGREDO, ESPACO, tokens.access_token, tokens.refresh_token, volta.searchParams.get("code")!];
		await a.chamar("/mcp", { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` } });
		delete a.motor.chaves[SEGREDO];
		await trocar(a, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id });
		const { pedido } = await iniciar(a);
		await aprovar(a, pedido);
	} finally {
		Object.assign(console, originais);
	}
	const tudo = linhas.join("\n");
	for (const s of segredos) assert.ok(!tudo.includes(s), `registro com ${s.slice(0, 6)}…`);
});
