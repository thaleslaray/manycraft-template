// Registro: uma linha JSON por pedido ao motor, com método, caminho do documento (identificadores trocados por <id>),
// status e tempo. Nunca leva query, corpo, chave nem espaço: o caminho registrado vem do modelo do documento,
// não do caminho real, então nenhum valor digitado pelo modelo entra na linha.

export interface DadosDoRegistro {
	metodo: string;
	modelo: string; // caminho do documento que casou, ex.: /api/contacts/{id}
	status: number;
	ms: number;
}

export function caminhoAnonimo(modelo: string): string {
	return modelo.replace(/\{[^}/]+\}/g, "<id>");
}

export function linhaDeRegistro(d: DadosDoRegistro): string {
	return JSON.stringify({ evento: "pedido", metodo: d.metodo, caminho: caminhoAnonimo(d.modelo), status: d.status, ms: d.ms });
}
