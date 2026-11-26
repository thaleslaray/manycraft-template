// Documento da API (OpenAPI 3.1) lido do motor pelo vínculo ENGINE, sem a seção "Formato ManyChat (congelada)".
// Fica em memória por 5 min e também na Cache API pelo mesmo tempo: rota nova do motor aparece no MCP sem publicar o MCP,
// e um isolado novo não paga de novo a ida ao motor (no protótipo eram ~1 s a cada isolado novo).

export const TAG_CONGELADA = "Formato ManyChat (congelada)";
export const CAMINHO_DOCUMENTO = "/api/docs/openapi.json";
export const VALIDADE_MS = 5 * 60 * 1000;
// Chave da Cache API (o endereço não é chamado; só identifica a entrada). Mudar o "v1" invalida o que estiver guardado.
const CHAVE_CACHE = "https://manycraft-mcp.cache/documento-filtrado-v1";

export const METODOS = ["get", "post", "put", "patch", "delete"] as const;
export type Metodo = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Operacao = { tags?: string[] } & Record<string, unknown>;
export type DocumentoApi = Record<string, unknown> & { paths: Record<string, Record<string, Operacao>> };

/** Um caminho do documento com o padrão que casa com caminhos reais e os métodos que ele define. */
export interface PadraoDeCaminho {
	modelo: string; // como está no documento, ex.: /api/contacts/{id}
	regex: RegExp;
	parametros: number; // quantos {param} o modelo tem (o mais literal ganha quando dois casam)
	metodos: Set<Metodo>;
}

export interface DocumentoPronto {
	spec: DocumentoApi;
	padroes: PadraoDeCaminho[];
	removidos: number;
}

/** Tira todo caminho que tem alguma operação na tag congelada. Não altera o objeto recebido. */
export function filtrarDocumento(original: DocumentoApi): { spec: DocumentoApi; removidos: number } {
	const paths: DocumentoApi["paths"] = {};
	let removidos = 0;
	for (const [caminho, ops] of Object.entries(original.paths ?? {})) {
		const congelado = METODOS.some((m) => ops?.[m]?.tags?.includes(TAG_CONGELADA));
		if (congelado) removidos++;
		else paths[caminho] = ops;
	}
	return { spec: { ...original, paths }, removidos };
}

const escapar = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, "\\$&");

export function montarPadroes(spec: DocumentoApi): PadraoDeCaminho[] {
	return Object.entries(spec.paths).map(([modelo, ops]) => ({
		modelo,
		regex: new RegExp("^" + escapar(modelo).replace(/\\?\{[^}/]+\\?\}/g, "[^/]+") + "$"),
		parametros: (modelo.match(/\{[^}/]+\}/g) ?? []).length,
		metodos: new Set(METODOS.filter((m) => ops?.[m]).map((m) => m.toUpperCase() as Metodo)),
	}));
}

export function prepararDocumento(original: DocumentoApi): DocumentoPronto {
	const { spec, removidos } = filtrarDocumento(original);
	return { spec, padroes: montarPadroes(spec), removidos };
}

export interface FonteDoDocumento {
	engine: Pick<Fetcher, "fetch">;
	/** caches.default no Worker; ausente nos testes ou onde não houver Cache API. */
	cache?: Pick<Cache, "match" | "put">;
	/** Para guardar na Cache API sem segurar a resposta (ctx.waitUntil). */
	esperar?: (p: Promise<unknown>) => void;
	agora?: () => number;
	registrar?: (linha: string) => void;
}

export class DocumentoIndisponivel extends Error {}

let memoria: { pronto: DocumentoPronto; expira: number } | undefined;
let carregando: Promise<DocumentoPronto> | undefined;

/** Só para os testes: esquece o que está em memória. */
export function esquecerDocumento() {
	memoria = undefined;
	carregando = undefined;
}

export async function obterDocumento(fonte: FonteDoDocumento): Promise<DocumentoPronto> {
	const agora = fonte.agora ?? Date.now;
	if (memoria && memoria.expira > agora()) return memoria.pronto;
	carregando ??= carregar(fonte).finally(() => { carregando = undefined; });
	return carregando;
}

async function carregar(fonte: FonteDoDocumento): Promise<DocumentoPronto> {
	const agora = fonte.agora ?? Date.now;
	const registrar = fonte.registrar ?? ((l: string) => console.log(l));
	const t0 = agora();

	const guardado = await fonte.cache?.match(CHAVE_CACHE).catch(() => undefined);
	if (guardado) {
		try {
			const spec = (await guardado.json()) as DocumentoApi;
			const pronto: DocumentoPronto = { spec, padroes: montarPadroes(spec), removidos: Number(guardado.headers.get("x-removidos") ?? 0) };
			memoria = { pronto, expira: agora() + VALIDADE_MS };
			registrar(JSON.stringify({ evento: "documento", origem: "cache", ms: agora() - t0, caminhos: pronto.padroes.length }));
			return pronto;
		} catch {
			// entrada estragada: segue para o motor
		}
	}

	const res = await fonte.engine.fetch(`https://engine${CAMINHO_DOCUMENTO}`);
	if (!res.ok) throw new DocumentoIndisponivel(`Documento da API indisponível: o motor respondeu ${res.status}.`);
	const pronto = prepararDocumento((await res.json()) as DocumentoApi);
	memoria = { pronto, expira: agora() + VALIDADE_MS };
	registrar(JSON.stringify({ evento: "documento", origem: "motor", ms: agora() - t0, caminhos: pronto.padroes.length, removidos: pronto.removidos }));

	if (fonte.cache) {
		const resposta = new Response(JSON.stringify(pronto.spec), {
			headers: {
				"content-type": "application/json",
				"cache-control": `max-age=${VALIDADE_MS / 1000}`,
				"x-removidos": String(pronto.removidos),
			},
		});
		const put = fonte.cache.put(CHAVE_CACHE, resposta).catch(() => {});
		if (fonte.esperar) fonte.esperar(put);
		else await put;
	}
	return pronto;
}
