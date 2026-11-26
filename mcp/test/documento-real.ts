// O documento real da API, gravado pelo `npm run check` (etapa "inventário de rotas da API"), o mesmo servido em
// GET /api/docs/openapi.json. Fora do check o arquivo pode faltar: aí os testes que dependem dele são pulados com aviso.
// No check (MCP_EXIGE_DOCUMENTO=1) o arquivo sempre existe, porque o inventário roda antes; se faltar, o teste falha.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DocumentoApi } from "../src/documento.ts";

export const REAL = fileURLToPath(new URL("../../.scratch/api-docs/openapi.json", import.meta.url).href);

/** Valor para a opção `skip` de `test()`: false quando o arquivo existe (ou quando o check exige o arquivo). */
export function pularSemDocumento(): false | string {
	if (existsSync(REAL) || process.env.MCP_EXIGE_DOCUMENTO === "1") return false;
	const aviso = "sem .scratch/api-docs/openapi.json (rode npm run check na raiz): teste contra o documento real pulado";
	console.warn(`AVISO: ${aviso}`);
	return aviso;
}

export function lerDocumentoReal(): DocumentoApi {
	if (!existsSync(REAL)) throw new Error(`Falta ${REAL}: o inventário de rotas do npm run check deveria tê-lo gravado.`);
	return JSON.parse(readFileSync(REAL, "utf8")) as DocumentoApi;
}
