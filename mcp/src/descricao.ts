// Texto acrescentado ao fim da descrição da ferramenta `execute`. As descrições de `search` e `execute` são fixas no
// @cloudflare/codemode; a opção `description` de openApiMcpServer() só acrescenta texto à de `execute`.
import { TEMPO_MAXIMO_MS, TETO_PEDIDOS_POR_EXECUCAO } from "./limites.ts";

export const TEXTO_EXECUTE = `Regras da API do ManyCraft:
- Use search antes para achar a rota e os parâmetros certos.
- A API responde em JSON. O documento traz o formato da resposta (responses["200"]) só das rotas mais usadas; quando o schema vier vazio, chame a rota uma vez para ver o formato antes de montar o resto.
- Devolva só os campos necessários, nunca a resposta inteira: resposta grande é cortada e cada item perde campos, inclusive o id. Em listas, escolha os campos com map e inclua sempre o id (rows.map(c => ({ id: c.id, name: c.name }))).
- Rotas que só podem ser usadas no painel respondem 403 ("Esta ação só pode ser feita no painel."): não insista, diga isso ao usuário.
- Listas paginam por next_cursor: passe o valor em query.cursor para a próxima página. Em /api/contacts o limit é ignorado e cada página traz 40 contatos.
- Erros chegam como "API respondeu <status>: <mensagem do motor>"; leia a mensagem e corrija o pedido.
- Ações irreversíveis (todo DELETE, enviar mensagem ou transmissão, descadastrar, juntar contatos, mexer em conexão) vêm bloqueadas com "Ação irreversível bloqueada". Quem libera é o dono, no cadastro do conector: não tente contornar por outra rota, avise o usuário.
- Cada execute faz no máximo ${TETO_PEDIDOS_POR_EXECUCAO} pedidos à API e roda por no máximo ${TEMPO_MAXIMO_MS / 1000} segundos: trabalho maior vai em mais de uma chamada.`;
