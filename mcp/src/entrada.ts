// Entrada pelos cabeçalhos: só POST em /mcp, e os dois cabeçalhos do conector conferidos antes de criar o servidor MCP.
// Desde a ficha 07 é o caminho avançado (scripts, Claude Code): o principal é conectar pelo login (provedor.ts), e este
// caminho roda dentro de `resolveExternalToken` quando o token não é um dos emitidos pelo login.

export const ROTA_MCP = "/mcp";

/**
 * Cabeçalho que libera as ações irreversíveis (irreversiveis.ts). Só quem cadastra o conector o manda; o código do
 * modelo não tem como pôr cabeçalho no pedido HTTP do conector. Vale só o valor "permitir", sem diferenciar maiúsculas.
 */
export const CABECALHO_IRREVERSIVEIS = "x-manycraft-irreversiveis";

export type ResultadoDaEntrada =
	| { ok: true; authorization: string; workspace: string; irreversiveisLiberados: boolean }
	| { ok: false; status: number; mensagem: string; resposta: Response };

export const MENSAGEM_SEM_CHAVE = "Cabeçalho authorization ausente ou fora do formato 'Bearer <chave>'. Use uma chave de perfil do ManyCraft, ou conecte pelo login.";
export const MENSAGEM_SEM_ESPACO = "Falta o cabeçalho x-workspace (o id do espaço de trabalho).";
export const MENSAGEM_METODO = "Método não permitido. O MCP do ManyCraft só aceita POST em /mcp.";
export const MENSAGEM_FORA_DO_MCP = "Não encontrado. O MCP do ManyCraft responde em /mcp.";

const erro = (status: number, mensagem: string, headers?: HeadersInit) =>
	({ ok: false, status, mensagem, resposta: Response.json({ error: mensagem }, { status, headers }) }) as const;

export function conferirEntrada(request: Request): ResultadoDaEntrada {
	const url = new URL(request.url);
	if (url.pathname !== ROTA_MCP) return erro(404, MENSAGEM_FORA_DO_MCP);

	// Servidor sem sessão: não há fluxo de eventos para abrir (GET) nem sessão para encerrar (DELETE). Sem isto o GET
	// abria um fluxo que nunca mandava nada e segurava a conexão (revisão da ficha 05).
	if (request.method !== "POST") return erro(405, MENSAGEM_METODO, { allow: "POST" });

	const authorization = normalizarChave(/^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization")?.trim() ?? "")?.[1]);
	if (!authorization) {
		return erro(401, MENSAGEM_SEM_CHAVE);
	}
	const workspace = request.headers.get("x-workspace")?.trim() ?? "";
	if (!workspace) return erro(400, MENSAGEM_SEM_ESPACO);

	const irreversiveisLiberados = (request.headers.get(CABECALHO_IRREVERSIVEIS) ?? "").trim().toLowerCase() === "permitir";

	return { ok: true, authorization, workspace, irreversiveisLiberados };
}

/**
 * A chave vale com ou sem o prefixo "perfil:" (o painel já a mostra com ele; quem colar sem, ou repetir o prefixo,
 * não leva 401 por isso). Para o motor segue sempre como "Bearer perfil:<chave>". Sem chave, undefined.
 */
export function normalizarChave(bruta: string | undefined | null): string | undefined {
	const chave = bruta?.trim().replace(/^(?:perfil:)+/, "");
	return chave && !/\s/.test(chave) ? `Bearer perfil:${chave}` : undefined;
}
