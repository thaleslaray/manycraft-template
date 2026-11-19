/**
 * Recursos que existem no código mas saem da interface até serem provados no ambiente publicado.
 * Google Sheets, Hotmart e Pixel: motor e testes prontos, nunca usados de verdade (ver .scratch/pendencias/integracoes-ocultas.md).
 * Para voltar a mostrar, troque para false; nada mais precisa mudar.
 */
export const integrationsHidden = true

/**
 * Menus de Configurações > Extensões que o dono decidiu não usar por ora (19/11/2026): Aplicativos e Modelos instalados.
 * O código das telas continua existindo, mas elas ficam inacessíveis (nem pelo endereço) até a chave voltar a false. Ver .scratch/pendencias/menus-ocultos.md.
 */
export const appsMenuHidden = true
export const installedTemplatesMenuHidden = true
