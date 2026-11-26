// Confere a chave de perfil no motor antes de gastar uma execução no ambiente isolado.
//
// Sem isto, uma chave inventada passava pela entrada (que só olha o formato) e `tools/list` e `search` respondiam: cada
// `search` carrega um Worker dinâmico, que é cobrado (revisão da ficha 05). Só o 401 do motor recusa; qualquer outra
// resposta (inclusive erro do motor) deixa passar, e o `execute` continua conferido pelo motor a cada pedido.
// O resultado fica guardado por 5 minutos, pelo resumo SHA-256 da chave com o espaço: a chave em si nunca é guardada.

/** Rota leve, que toda chave de perfil válida alcança (leitura). */
const ROTA_DE_CONFERENCIA = "https://engine/api/tags";
export const VALIDADE_MS = 5 * 60_000;
const MAXIMO_NA_MEMORIA = 500;

const naMemoria = new Map<string, { valida: boolean; ate: number }>();

export interface OpcoesDaChave {
	engine: { fetch(input: string, init?: RequestInit): Promise<Response> };
	authorization: string;
	workspace: string;
	cache?: { match(chave: string): Promise<Response | undefined>; put(chave: string, resposta: Response): Promise<void> };
	esperar?: (p: Promise<unknown>) => void;
	agora?: () => number;
}

async function resumo(texto: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto)));
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `true` quando a chave pode seguir; `false` só quando o motor respondeu 401 para ela. */
export async function chaveAceita(o: OpcoesDaChave): Promise<boolean> {
	const agora = o.agora ?? Date.now;
	const id = await resumo(`${o.authorization}\n${o.workspace}`);
	const guardada = naMemoria.get(id);
	if (guardada && guardada.ate > agora()) return guardada.valida;

	const chaveDoCache = `https://manycraft-mcp.interno/chave/${id}`;
	const lembrar = (valida: boolean) => {
		if (naMemoria.size >= MAXIMO_NA_MEMORIA) naMemoria.clear();
		naMemoria.set(id, { valida, ate: agora() + VALIDADE_MS });
	};
	try {
		const doCache = await o.cache?.match(chaveDoCache);
		if (doCache) {
			const valida = (await doCache.text()) === "1";
			lembrar(valida);
			return valida;
		}
	} catch {
		// Cache fora do ar: confere no motor.
	}

	let valida = true;
	try {
		const r = await o.engine.fetch(ROTA_DE_CONFERENCIA, { headers: { authorization: o.authorization, "x-workspace": o.workspace } });
		await r.body?.cancel();
		valida = r.status !== 401;
	} catch {
		// Motor fora do ar não é motivo para recusar a chave; não guarda o resultado.
		return true;
	}
	lembrar(valida);
	const guardar = o.cache
		?.put(chaveDoCache, new Response(valida ? "1" : "0", { headers: { "cache-control": `max-age=${VALIDADE_MS / 1000}` } }))
		.catch(() => {});
	if (guardar) o.esperar ? o.esperar(guardar) : await guardar;
	return valida;
}

/**
 * Conferência estrita, sem guardar nada, para conectar pelo login (/callback) e para a renovação do token: a chave
 * precisa valer E a pessoa precisa ser membro do espaço. A mesma rota leve, com os dois cabeçalhos, e só 200 é "ok":
 * 401 é chave recusada (inválida ou revogada), 404 é espaço em que a pessoa não é membro; o resto (inclusive motor
 * fora do ar) é "motor", que não decide nada.
 */
export async function conferirChaveEEspaco(
	engine: OpcoesDaChave["engine"],
	authorization: string,
	workspace: string,
): Promise<"ok" | "chave" | "espaco" | "motor"> {
	try {
		const r = await engine.fetch(ROTA_DE_CONFERENCIA, { headers: { authorization, "x-workspace": workspace } });
		await r.body?.cancel();
		return r.status === 200 ? "ok" : r.status === 401 ? "chave" : r.status === 404 ? "espaco" : "motor";
	} catch {
		return "motor";
	}
}

/** Só para os testes. */
export const esquecerChaves = () => naMemoria.clear();
