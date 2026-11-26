// Ambiente dos testes da camada de autorização: o pacote @cloudflare/workers-oauth-provider de verdade, rodando no Node.
// O pacote importa `cloudflare:workers` só para reconhecer classes WorkerEntrypoint; aqui ele vira uma classe vazia.
// O KV e o motor são falsos e ficam em memória.
import { registerHooks } from "node:module";

registerHooks({
	resolve(especificador, contexto, proximo) {
		if (especificador === "cloudflare:workers") {
			return { url: "data:text/javascript,export class WorkerEntrypoint {}", shortCircuit: true };
		}
		return proximo(especificador, contexto);
	},
});

type Entrada = { valor: string; metadata?: unknown; expira?: number };

/** KV em memória com o que o pacote usa: get (texto ou json), put com validade e metadados, delete e list por prefixo. */
export function kvFalso() {
	const dados = new Map<string, Entrada>();
	const viva = (k: string) => {
		const e = dados.get(k);
		if (e?.expira !== undefined && e.expira <= Date.now()) {
			dados.delete(k);
			return undefined;
		}
		return e;
	};
	return {
		dados,
		async get(k: string, opcao?: string | { type?: string }) {
			const e = viva(k);
			if (!e) return null;
			const tipo = typeof opcao === "string" ? opcao : opcao?.type;
			return tipo === "json" ? JSON.parse(e.valor) : e.valor;
		},
		async put(k: string, valor: string, o?: { expirationTtl?: number; expiration?: number; metadata?: unknown }) {
			const expira = o?.expirationTtl ? Date.now() + o.expirationTtl * 1000 : o?.expiration ? o.expiration * 1000 : undefined;
			dados.set(k, { valor: String(valor), metadata: o?.metadata, expira });
		},
		async delete(k: string) {
			dados.delete(k);
		},
		async list(o: { prefix?: string; limit?: number; cursor?: string } = {}) {
			const keys = [...dados.keys()]
				.filter((k) => k.startsWith(o.prefix ?? "") && viva(k))
				.sort()
				.map((name) => ({ name, metadata: dados.get(name)?.metadata }));
			return { keys, list_complete: true, cursor: "" };
		},
		/** Faz a entrada vencer agora (para o teste do pedido vencido). */
		vencer(k: string) {
			const e = dados.get(k);
			if (e) e.expira = Date.now() - 1;
		},
	};
}

/**
 * Motor falso: responde a GET /api/tags pela tabela de chaves (chave → espaços de que a pessoa é membro), como o motor:
 * chave desconhecida ou revogada → 401; espaço alheio → 404. Guarda os pedidos recebidos.
 */
export function motorFalso(chaves: Record<string, string[]>) {
	const pedidos: { url: string; authorization: string | null; workspace: string | null }[] = [];
	let foraDoAr = false;
	return {
		pedidos,
		chaves,
		derrubar(sim = true) {
			foraDoAr = sim;
		},
		async fetch(entrada: RequestInfo | URL, init?: RequestInit) {
			const req = new Request(entrada, init);
			pedidos.push({ url: req.url, authorization: req.headers.get("authorization"), workspace: req.headers.get("x-workspace") });
			if (foraDoAr) throw new Error("motor fora do ar");
			const segredo = /^Bearer perfil:(\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
			const espacos = segredo ? chaves[segredo] : undefined;
			if (!espacos) return Response.json({ error: "Chave inválida ou revogada." }, { status: 401 });
			if (!espacos.includes(req.headers.get("x-workspace") ?? "")) return Response.json({ error: "Workspace não encontrado." }, { status: 404 });
			return Response.json({ items: [] });
		},
	};
}

export const MCP_URL = "http://127.0.0.1:8790";
export const PAINEL_URL = "http://localhost:5173";

/** Base64url sem preenchimento (PKCE). */
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function pkce() {
	const verificador = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const desafio = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verificador))));
	return { verificador, desafio };
}
