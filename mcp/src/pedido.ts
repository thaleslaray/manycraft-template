// Função de pedido: a única porta do código gerado pelo modelo para a API. Roda no Worker (fora do ambiente isolado),
// confere o pedido contra o documento filtrado, acrescenta a chave e o espaço e chama o motor pelo vínculo ENGINE.
import type { RequestOptions } from "@cloudflare/codemode/mcp";
import type { DocumentoPronto, Metodo, PadraoDeCaminho } from "./documento.ts";
import { linhaDeRegistro } from "./registro.ts";

/** O pedido já conferido (caminho no documento, método definido), antes de ir ao motor. */
export interface PedidoConferido {
	metodo: Metodo;
	caminho: string; // caminho real pedido, ex.: /api/contacts/123
	modelo: string; // caminho do documento que casou, ex.: /api/contacts/{id}
	corpo?: unknown; // o body pedido, para as operações irreversíveis só conforme o corpo (ex.: status da transmissão)
}

/**
 * Ponto de encaixe usado pela trava de irreversíveis (`travaDeIrreversiveis` em irreversiveis.ts).
 * O teto de pedidos por execução fica em limites.ts, em volta do executor (um contador por chamada de `execute`).
 * Lançar um Error em `antesDoPedido` recusa o pedido sem chamar o motor; a mensagem chega ao modelo.
 */
export interface GanchosDoPedido {
	antesDoPedido?: (pedido: PedidoConferido) => void | Promise<void>;
}

export interface OpcoesDaFuncaoDePedido {
	engine: Pick<Fetcher, "fetch">;
	documento: DocumentoPronto;
	authorization: string;
	workspace: string;
	registrar?: (linha: string) => void;
	agora?: () => number;
	ganchos?: GanchosDoPedido;
}

const METODOS_ACEITOS = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export class PedidoRecusado extends Error {}

/** Acha o caminho do documento para um caminho real; entre os que casam, o mais literal (menos parâmetros). */
export function acharModelo(padroes: PadraoDeCaminho[], caminho: string): PadraoDeCaminho[] {
	return padroes.filter((p) => p.regex.test(caminho)).sort((a, b) => a.parametros - b.parametros);
}

function conferirCaminho(caminho: unknown): string {
	if (typeof caminho !== "string" || !caminho.startsWith("/api/")) {
		throw new PedidoRecusado(`Caminho recusado: precisa começar com /api/ (recebido ${String(caminho)}).`);
	}
	if (/[?#]/.test(caminho)) {
		throw new PedidoRecusado(`Caminho recusado: passe os parâmetros em query, não no caminho (${caminho.split(/[?#]/)[0]}).`);
	}
	// Nada de "..", "." ou barra dupla: o endereço normalizado precisa ser o mesmo caminho pedido.
	const segmentos = caminho.slice(1).split("/");
	const normalizado = new URL(caminho, "https://engine").pathname;
	if (normalizado !== caminho || segmentos.some((s) => s === "" || s === "." || s === ".." || /%2e|%2f/i.test(s))) {
		throw new PedidoRecusado(`Caminho recusado: ${caminho} não é um caminho válido.`);
	}
	return caminho;
}

/** Tira a chave (e, nas mensagens de erro, o espaço) de qualquer texto que volte para o modelo. */
function ocultar(texto: string, segredos: string[]): string {
	let saida = texto;
	for (const s of segredos) if (s && saida.includes(s)) saida = saida.split(s).join("[oculto]");
	return saida;
}

function mensagemDoMotor(corpo: unknown): string {
	if (corpo && typeof corpo === "object") {
		const o = corpo as Record<string, unknown>;
		const principal = typeof o.error === "string" ? o.error : typeof o.message === "string" ? o.message : undefined;
		if (principal) {
			const extra = o.details ?? o.issues ?? o.fields;
			return extra !== undefined ? `${principal} ${JSON.stringify(extra)}` : principal;
		}
		return JSON.stringify(corpo);
	}
	return typeof corpo === "string" && corpo.trim() ? corpo.trim().slice(0, 500) : "(sem mensagem)";
}

export function criarFuncaoDePedido(opcoes: OpcoesDaFuncaoDePedido): (pedido: RequestOptions) => Promise<unknown> {
	const { engine, documento, authorization, workspace, ganchos } = opcoes;
	const registrar = opcoes.registrar ?? ((l: string) => console.log(l));
	const agora = opcoes.agora ?? Date.now;
	const chave = authorization.slice("Bearer ".length);

	return async (pedido: RequestOptions) => {
		const metodo = String(pedido?.method ?? "").toUpperCase();
		const caminho = conferirCaminho(pedido?.path);
		if (!METODOS_ACEITOS.has(metodo)) {
			throw new PedidoRecusado(`Método recusado: ${metodo || "(vazio)"} (use GET, POST, PUT, PATCH ou DELETE).`);
		}
		const candidatos = acharModelo(documento.padroes, caminho);
		if (!candidatos.length) {
			throw new PedidoRecusado(`Caminho recusado: ${caminho} não está no documento da API. Use search para achar a rota.`);
		}
		const casou = candidatos.find((p) => p.metodos.has(metodo as Metodo));
		if (!casou) {
			const definidos = [...new Set(candidatos.flatMap((p) => [...p.metodos]))].join(", ");
			throw new PedidoRecusado(`Método recusado: ${metodo} não existe para ${candidatos[0].modelo} (o documento define ${definidos}).`);
		}
		const conferido: PedidoConferido = { metodo: metodo as Metodo, caminho, modelo: casou.modelo, ...(pedido.body !== undefined ? { corpo: pedido.body } : {}) };
		await ganchos?.antesDoPedido?.(conferido);

		const alvo = new URL(`https://engine${caminho}`);
		for (const [k, v] of Object.entries(pedido.query ?? {})) {
			if (v === undefined || v === null) continue;
			if (Array.isArray(v)) for (const item of v) alvo.searchParams.append(k, String(item));
			else alvo.searchParams.set(k, String(v));
		}
		const headers = new Headers({ authorization, "x-workspace": workspace, accept: "application/json" });
		let body: BodyInit | undefined;
		if (pedido.body !== undefined && metodo !== "GET") {
			if (pedido.rawBody && typeof pedido.body === "string") {
				body = pedido.body;
				headers.set("content-type", pedido.contentType ?? "text/plain");
			} else {
				body = JSON.stringify(pedido.body);
				headers.set("content-type", pedido.contentType ?? "application/json");
			}
		}

		const t0 = agora();
		const res = await engine.fetch(alvo.toString(), { method: metodo, headers, body });
		registrar(linhaDeRegistro({ metodo: conferido.metodo, modelo: casou.modelo, status: res.status, ms: agora() - t0 }));

		const texto = ocultar(await res.text(), [chave]);
		const tipo = res.headers.get("content-type") ?? "";
		let corpo: unknown = texto === "" ? null : texto;
		if (tipo.includes("json") && texto) {
			try { corpo = JSON.parse(texto); } catch { /* fica o texto */ }
		}
		if (!res.ok) {
			throw new Error(ocultar(`API respondeu ${res.status}: ${mensagemDoMotor(corpo)}`, [chave, workspace]));
		}
		return corpo;
	};
}
