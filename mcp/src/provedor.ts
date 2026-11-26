// Conectar por login (ficha 07). O Worker é também o servidor de autorização, com @cloudflare/workers-oauth-provider:
//
// - /authorize confere o pedido do cliente (parseAuthRequest), guarda-o no KV por 10 minutos sob um id aleatório de
//   256 bits e manda o navegador para a tela de consentimento do painel levando só esse id.
// - /pedido/<id> devolve ao painel só o nome do cliente e para onde vai o acesso (CORS só para a origem do painel).
// - /callback recebe o formulário do painel (id do pedido, chave de perfil recém-criada, espaço, irreversíveis),
//   consome o pedido uma vez só, confere chave e espaço no motor e chama completeAuthorization. A biblioteca cifra os
//   props; o MCP os recebe em ctx.props.
// - Os cabeçalhos antigos (Bearer <chave> + x-workspace) seguem valendo por resolveExternalToken.
// - Na renovação do token a chave é conferida de novo: revogada no painel → invalid_grant.
//
// O registro (console) nunca leva a chave, o token, o código nem o espaço.
import {
	AuthorizationError,
	authorizationErrorRedirect,
	CimdFetchError,
	ExternalTokenError,
	OAuthError,
	OAuthProvider,
	type AuthRequest,
	type OAuthHelpers,
	type ResolveExternalTokenInput,
	type TokenExchangeCallbackOptions,
} from "@cloudflare/workers-oauth-provider";
import { chaveAceita, conferirChaveEEspaco } from "./chave.ts";
import { CABECALHO_IRREVERSIVEIS, conferirEntrada, MENSAGEM_FORA_DO_MCP, MENSAGEM_METODO, MENSAGEM_SEM_CHAVE, normalizarChave, ROTA_MCP } from "./entrada.ts";

export const ROTA_AUTORIZAR = "/authorize";
export const ROTA_TOKEN = "/token";
export const ROTA_REGISTRO = "/register";
export const ROTA_PEDIDO = "/pedido/";
export const ROTA_CALLBACK = "/callback";
/** Prefixo das entradas do KV com o pedido em espera (não colide com os prefixos da biblioteca). */
export const PREFIXO_PEDIDO = "conector-pedido:";
export const VALIDADE_DO_PEDIDO_S = 10 * 60;
export const MENSAGEM_CHAVE_RECUSADA = "Chave inválida ou revogada. Conecte de novo pelo painel do ManyCraft (ou crie outra chave de perfil e cadastre o conector de novo).";

/** O que o MCP recebe em ctx.props, venha do login ou dos cabeçalhos. */
export interface PropsDoConector {
	authorization: string; // sempre "Bearer perfil:<chave>"
	workspace: string;
	irreversiveisLiberados: boolean;
}

export interface EnvDoConector {
	ENGINE: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
	OAUTH_KV: KVNamespace;
	/** Endereço público do MCP, sem a barra final (ex.: https://mcp.seu-dominio.example). */
	MCP_URL: string;
	/** Endereço do painel, onde fica a tela de consentimento. */
	PAINEL_URL: string;
	/** Posto pela biblioteca antes de chamar os handlers. */
	OAUTH_PROVIDER?: OAuthHelpers;
}

type ContextoComProps = ExecutionContext & { props?: unknown };
export interface ManipuladorDaApi {
	fetch(request: Request, env: EnvDoConector, ctx: ContextoComProps): Response | Promise<Response>;
}

interface PedidoGuardado {
	pedido: AuthRequest;
	cliente: string;
	dominio?: string;
	destino: string;
	local: boolean;
}

const semBarra = (u: string) => u.replace(/\/+$/, "");
const recursoDe = (env: EnvDoConector) => `${semBarra(env.MCP_URL)}${ROTA_MCP}`;
const metadadosDe = (env: EnvDoConector) => `${semBarra(env.MCP_URL)}/.well-known/oauth-protected-resource${ROTA_MCP}`;
const registrar = (dados: Record<string, unknown>) => console.log(JSON.stringify(dados));

async function resumo(texto: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto)));
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function idAleatorio(): string {
	return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const escapar = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Página simples em português para os erros do fluxo de conexão (nada do pedido do cliente entra no texto). */
function pagina(status: number, titulo: string, mensagem: string): Response {
	const html = `<!doctype html>
<html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapar(titulo)} · ManyCraft</title>
<style>body{font-family:system-ui,sans-serif;background:#fafafa;color:#18181b;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}main{max-width:420px;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:32px}h1{font-size:1.4rem;margin:0 0 12px}p{line-height:1.5;color:#52525b}</style>
<main><h1>${escapar(titulo)}</h1><p>${escapar(mensagem)}</p><p>Volte ao Claude e conecte o ManyCraft de novo.</p></main></html>`;
	return new Response(html, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-frame-options": "DENY",
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
			"referrer-policy": "no-referrer",
		},
	});
}

/**
 * Volta ao cliente depois do formulário do painel. Não pode ser 302: o navegador aplica a regra form-action do painel a
 * toda a cadeia de redirecionamentos do formulário, e o destino (claude.ai, um programa local) não está nela. Uma página
 * que redireciona sozinha é uma navegação nova, fora dessa regra.
 */
export function voltarAoCliente(destino: string): Response {
	const url = escapar(destino);
	const html = `<!doctype html>
<html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=${url}">
<title>Voltando ao aplicativo · ManyCraft</title>
<style>body{font-family:system-ui,sans-serif;background:#fafafa;color:#18181b;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}main{max-width:420px;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:32px}h1{font-size:1.4rem;margin:0 0 12px}p{line-height:1.5;color:#52525b}a{color:#18181b}</style>
<main><h1>Voltando ao aplicativo…</h1><p>Se nada acontecer, <a href="${url}">clique aqui para continuar</a>.</p></main></html>`;
	return new Response(html, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-frame-options": "DENY",
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
			"referrer-policy": "no-referrer",
		},
	});
}

const redirecionar = (destino: string) => new Response(null, { status: 302, headers: { location: destino, "cache-control": "no-store" } });

// ---------- /authorize ----------

async function autorizar(request: Request, env: EnvDoConector): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER!;
	let pedido: AuthRequest;
	let guardado: PedidoGuardado;
	try {
		pedido = await oauth.parseAuthRequest(request);
		const d = await oauth.describeConsent(pedido);
		guardado = { pedido, cliente: d.clientName, ...(d.clientDomain ? { dominio: d.clientDomain } : {}), destino: d.redirectHost, local: d.redirectIsLoopback };
	} catch (e) {
		if (e instanceof AuthorizationError && e.redirectTo) return redirecionar(e.redirectTo);
		if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
			registrar({ evento: "autorizar", resultado: "recusado", motivo: e instanceof AuthorizationError ? e.code : "cimd" });
			return pagina(400, "Pedido de conexão inválido", "O aplicativo mandou um pedido de conexão que não pôde ser conferido.");
		}
		throw e;
	}
	const id = idAleatorio();
	await env.OAUTH_KV.put(`${PREFIXO_PEDIDO}${id}`, JSON.stringify(guardado), { expirationTtl: VALIDADE_DO_PEDIDO_S });
	const destino = new URL("/conectar", env.PAINEL_URL);
	destino.searchParams.set("pedido", id);
	registrar({ evento: "autorizar", resultado: "ao-painel" });
	return redirecionar(destino.toString());
}

// ---------- /pedido/<id> ----------

const idValido = (id: string | null | undefined): id is string => !!id && /^[0-9a-f]{64}$/.test(id);

async function lerPedido(request: Request, env: EnvDoConector, id: string): Promise<Response> {
	const cors = { "access-control-allow-origin": new URL(env.PAINEL_URL).origin, vary: "origin", "cache-control": "no-store" };
	if (request.method !== "GET") return Response.json({ error: "Use GET." }, { status: 405, headers: { ...cors, allow: "GET" } });
	const guardado = idValido(id) ? await env.OAUTH_KV.get<PedidoGuardado>(`${PREFIXO_PEDIDO}${id}`, "json") : null;
	if (!guardado) return Response.json({ error: "Pedido de conexão vencido ou já usado." }, { status: 404, headers: cors });
	const { cliente, dominio, destino, local } = guardado;
	return Response.json({ cliente, ...(dominio ? { dominio } : {}), destino, local }, { headers: cors });
}

// ---------- /callback ----------

async function concluir(request: Request, env: EnvDoConector): Promise<Response> {
	if (request.method !== "POST") return pagina(405, "Endereço errado", "Este endereço só recebe a resposta da tela de conexão do ManyCraft.");
	// Formulário postado de outro site não consome o pedido.
	const origem = request.headers.get("origin");
	if (origem !== null && origem !== new URL(env.PAINEL_URL).origin) {
		registrar({ evento: "callback", resultado: "origem-recusada" });
		return pagina(403, "Pedido recusado", "A resposta não veio da tela de conexão do ManyCraft.");
	}
	let campos: FormData;
	try {
		campos = await request.formData();
	} catch {
		return pagina(400, "Pedido de conexão inválido", "A resposta da tela de conexão chegou incompleta.");
	}
	const texto = (nome: string) => {
		const v = campos.get(nome);
		return typeof v === "string" ? v.trim() : "";
	};

	// Consome o pedido antes de qualquer outra coisa: vale uma vez só, dê certo ou não.
	const id = texto("pedido");
	const chaveKv = `${PREFIXO_PEDIDO}${id}`;
	const guardado = idValido(id) ? await env.OAUTH_KV.get<PedidoGuardado>(chaveKv, "json") : null;
	if (!guardado) {
		registrar({ evento: "callback", resultado: "pedido-ausente" });
		return pagina(400, "Pedido vencido", "Este pedido de conexão venceu ou já foi usado. Os pedidos valem por 10 minutos.");
	}
	await env.OAUTH_KV.delete(chaveKv);

	if (texto("decisao") !== "aprovar") {
		registrar({ evento: "callback", resultado: "negado" });
		return voltarAoCliente(authorizationErrorRedirect(guardado.pedido, "access_denied", "A pessoa não autorizou o acesso."));
	}

	const authorization = normalizarChave(texto("token"));
	const workspace = texto("workspace");
	if (!authorization || !workspace) return pagina(400, "Pedido de conexão inválido", "A resposta da tela de conexão chegou sem a chave ou sem o espaço.");

	const conferencia = await conferirChaveEEspaco(env.ENGINE, authorization, workspace);
	registrar({ evento: "callback", resultado: conferencia });
	if (conferencia === "chave") return pagina(400, "Não foi possível conectar", "A chave foi recusada pelo ManyCraft (inválida ou revogada).");
	if (conferencia === "espaco") return pagina(400, "Não foi possível conectar", "Você não participa desse espaço de trabalho.");
	if (conferencia === "motor") return pagina(503, "Não foi possível conectar agora", "O ManyCraft não respondeu à conferência da chave. Tente de novo em instantes.");

	const props: PropsDoConector = { authorization, workspace, irreversiveisLiberados: texto("irreversiveis").toLowerCase() === "permitir" };
	// userId fica visível no KV (a biblioteca não o cifra): é um resumo da chave, nunca a chave nem o espaço.
	const userId = `c${(await resumo(authorization)).slice(0, 32)}`;
	const { redirectTo } = await env.OAUTH_PROVIDER!.completeAuthorization({ request: guardado.pedido, userId, metadata: {}, scope: [], props });
	return voltarAoCliente(redirectTo);
}

async function manipularPadrao(request: Request, env: EnvDoConector): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === ROTA_AUTORIZAR) return autorizar(request, env);
	if (pathname === ROTA_CALLBACK) return concluir(request, env);
	if (pathname.startsWith(ROTA_PEDIDO)) return lerPedido(request, env, pathname.slice(ROTA_PEDIDO.length));
	return Response.json({ error: MENSAGEM_FORA_DO_MCP }, { status: 404 });
}

// ---------- caminho dos cabeçalhos ----------

async function resolverCabecalhos({ request, env }: ResolveExternalTokenInput<EnvDoConector>) {
	const entrada = conferirEntrada(request);
	if (!entrada.ok) {
		throw new ExternalTokenError(entrada.status === 401 ? "invalid_token" : "invalid_request", { description: entrada.mensagem, statusCode: entrada.status });
	}
	const cache = typeof caches !== "undefined" ? caches.default : undefined;
	if (!(await chaveAceita({ engine: env.ENGINE, authorization: entrada.authorization, workspace: entrada.workspace, cache }))) {
		throw new ExternalTokenError("invalid_token", { description: MENSAGEM_CHAVE_RECUSADA, statusCode: 401 });
	}
	const props: PropsDoConector = { authorization: entrada.authorization, workspace: entrada.workspace, irreversiveisLiberados: entrada.irreversiveisLiberados };
	return { props, audience: recursoDe(env) };
}

// ---------- renovação ----------

async function aoTrocarToken(o: TokenExchangeCallbackOptions<EnvDoConector>) {
	if (o.grantType !== "refresh_token") return;
	const props = o.props as PropsDoConector;
	const conferencia = await conferirChaveEEspaco(o.env.ENGINE, props.authorization, props.workspace);
	registrar({ evento: "renovar", resultado: conferencia });
	if (conferencia === "chave" || conferencia === "espaco") {
		// invalid_grant também revoga o grant e os tokens dele (a biblioteca faz isso).
		throw new OAuthError("invalid_grant", { description: "A chave do conector foi revogada no painel. Conecte o ManyCraft de novo." });
	}
	if (conferencia === "motor") {
		throw new OAuthError("temporarily_unavailable", { description: "O ManyCraft não respondeu. Tente de novo em instantes.", statusCode: 503, headers: { "retry-after": "30" } });
	}
}

// ---------- erros da biblioteca ----------

function aoErrar(e: { code: string; description: string; status: number; headers: Record<string, string>; internal: { category: string; reason: string } }) {
	registrar({ evento: "oauth-erro", categoria: e.internal.category, motivo: e.internal.reason, status: e.status });
	// Erros do caminho dos cabeçalhos: o corpo continua o de antes ({ error: "<mensagem em português>" }), com o desafio.
	if (e.internal.reason === "resolver_rejected") return Response.json({ error: e.description }, { status: e.status, headers: e.headers });
}

// ---------- API protegida ----------

async function manipularApi(api: ManipuladorDaApi, request: Request, env: EnvDoConector, ctx: ContextoComProps): Promise<Response> {
	if (new URL(request.url).pathname !== ROTA_MCP) return Response.json({ error: MENSAGEM_FORA_DO_MCP }, { status: 404 });
	const props = ctx.props as PropsDoConector;
	// Token do login: a chave por trás dele pode ter sido revogada no painel. Pelo caminho dos cabeçalhos isto já foi
	// conferido (e fica guardado em chave.ts), então aqui não custa outra ida ao motor.
	const cache = typeof caches !== "undefined" ? caches.default : undefined;
	if (!(await chaveAceita({ engine: env.ENGINE, authorization: props.authorization, workspace: props.workspace, cache, esperar: (p) => ctx.waitUntil(p) }))) {
		return Response.json(
			{ error: MENSAGEM_CHAVE_RECUSADA },
			{ status: 401, headers: { "www-authenticate": `Bearer realm="OAuth", error="invalid_token", resource_metadata="${metadadosDe(env)}"`, "cache-control": "no-store" } },
		);
	}
	return api.fetch(request, env, ctx);
}

function criarProvedor(api: ManipuladorDaApi, env: EnvDoConector) {
	const mcpUrl = semBarra(env.MCP_URL);
	return new OAuthProvider<EnvDoConector>({
		apiRoute: ROTA_MCP,
		apiHandler: { fetch: (request, envDaVez, ctx) => manipularApi(api, request, envDaVez as EnvDoConector, ctx as ContextoComProps) },
		defaultHandler: { fetch: (request, envDaVez) => manipularPadrao(request, envDaVez as EnvDoConector) },
		authorizeEndpoint: ROTA_AUTORIZAR,
		tokenEndpoint: ROTA_TOKEN,
		clientRegistrationEndpoint: ROTA_REGISTRO,
		// CIMD só é anunciado com a flag global_fetch_strictly_public no wrangler.jsonc (proteção contra SSRF).
		clientIdMetadataDocumentEnabled: true,
		resourceMetadata: { resource: `${mcpUrl}${ROTA_MCP}`, authorization_servers: [mcpUrl], resource_name: "ManyCraft" },
		resolveExternalToken: resolverCabecalhos,
		tokenExchangeCallback: aoTrocarToken,
		onError: aoErrar,
	});
}

/**
 * O Worker inteiro: o provedor de autorização em volta do MCP. Duas coisas ficam antes e depois dele para manter as
 * respostas de antes em /mcp: 405 para outro método que não POST, e a mensagem em português no 401 sem credencial
 * (a biblioteca responde esse 401 sem corpo, só com o desafio).
 */
export function criarWorker(api: ManipuladorDaApi): ExportedHandler<EnvDoConector> {
	let atual: { url: string; provedor: OAuthProvider<EnvDoConector> } | undefined;
	return {
		async fetch(request, env, ctx) {
			const { pathname } = new URL(request.url);
			if (pathname === ROTA_MCP && request.method !== "POST") {
				return Response.json({ error: MENSAGEM_METODO }, { status: 405, headers: { allow: "POST" } });
			}
			if (!atual || atual.url !== env.MCP_URL) atual = { url: env.MCP_URL, provedor: criarProvedor(api, env) };
			const resposta = await atual.provedor.fetch(request, env, ctx);
			if (pathname === ROTA_MCP && resposta.status === 401 && resposta.body === null) {
				const headers = new Headers(resposta.headers);
				headers.set("content-type", "application/json");
				return new Response(JSON.stringify({ error: MENSAGEM_SEM_CHAVE }), { status: 401, headers });
			}
			return resposta;
		},
	};
}

export { CABECALHO_IRREVERSIVEIS };
