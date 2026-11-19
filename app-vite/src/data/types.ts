/**
 * Contrato painel/motor: a fonte única é engine/src/contracts.ts, o formato que a API devolve.
 * Só tipos: nada daqui entra no pacote do painel nem é carregado pelos testes (node --test).
 */
export type * from "../../../engine/src/contracts"
