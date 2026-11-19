import type { AreaCatalogo } from '../tipos'
import { enabledSchema } from '../../schemas/enabled'
import { connectionUsernameSchema } from '../../channels/meta-account'
import { connectionBusinessProfileSchema, connectionCreateSchema, connectionGroupsQuerySchema, connectionListQuerySchema, connectionPageQuerySchema, connectionPatchSchema, connectionRotateSchema } from '../../connections'
import { connectionDisconnectionSchema } from '../../notices'
import { threadControlSchema } from '../../channels/core/routing'

// Área connections: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'connections',
  nome: 'Conexões',
  descricao: 'Os canais conectados ao espaço (Instagram, WhatsApp, Telegram, e-mail...).',
  entradas: [
    { metodo: 'GET', caminho: '/api/connections', resumo: 'Lista as conexões (canais) do espaço, sem credenciais; filtre por tipo de canal com `kind`.', query: connectionListQuerySchema },
    { metodo: 'POST', caminho: '/api/connections', resumo: 'Cria uma conexão de canal com as credenciais coladas (token, ID do número...). WhatsApp oficial: o webhook é configurado só no número (endereço alternativo da Meta, `POST /{phone-number-id}` com `webhook_configuration`), nunca na URL do app; aceito, `step` vem `done` com `notice` e a conexão fica pendente até o primeiro evento; recusado ou sem o ID da conta do WhatsApp Business (WABA) confirmado, `step` é o passo manual (`manual_webhook`) com o motivo em `reason`.', corpo: connectionCreateSchema, exemplo: { kind: 'telegram', displayName: 'Bot da loja', credentials: { botToken: 'SEU_TOKEN_AQUI' } } },
    { metodo: 'GET', caminho: '/api/connections/capabilities', resumo: 'Perfil padrão de cada tipo de canal: quais blocos e recursos ele suporta.' },
    { metodo: 'GET', caminho: '/api/connections/catalog', resumo: 'Catálogo dos canais e provedores que dá para conectar, com os campos de credencial de cada um.' },
    { metodo: 'GET', caminho: '/api/connections/:id', resumo: 'Mostra uma conexão: estado, permissões, webhook e opções (sem credenciais).' },
    { metodo: 'PATCH', caminho: '/api/connections/:id', resumo: 'Altera o nome e as opções do provedor (digitando, marcar como lida...); credencial só muda por /rotate.', corpo: connectionPatchSchema, exemplo: { displayName: 'WhatsApp vendas' } },
    { metodo: 'DELETE', caminho: '/api/connections/:id', resumo: 'Arquiva a conexão; com `?delete_contacts=1`, exclui também os contatos que só existem por ela. WhatsApp oficial: tira o webhook do número só se ele aponta para este servidor (o de outro sistema fica).' },
    { metodo: 'GET', caminho: '/api/connections/:id/business-profile', resumo: 'Lê o perfil comercial da conta no provedor (sobre, descrição, endereço, sites).' },
    { metodo: 'PUT', caminho: '/api/connections/:id/business-profile', resumo: 'Atualiza o perfil comercial da conta no provedor. Recusa da Meta: 422 (ou 409 para token recusado, 429 para limite) com código e subcódigo traduzidos, sem repetir o texto da Meta; 502 só quando a Meta não responde. Conexão sem credencial salva: 409 "sem credencial salva, cole o token de novo".', corpo: connectionBusinessProfileSchema, exemplo: { about: 'Atendimento das 9h às 18h', email: 'contato@exemplo.com', websites: ['https://exemplo.com'] } },
    { metodo: 'GET', caminho: '/api/connections/:id/catalog', resumo: 'Catálogo de produtos ligado à conta da conexão, quando o provedor oferece.' },
    { metodo: 'POST', caminho: '/api/connections/:id/connect', resumo: 'Situação do pareamento por QR code: um QR novo enquanto espera a leitura, `done` quando pareou.' },
    { metodo: 'PUT', caminho: '/api/connections/:id/disconnection', resumo: 'Define o que acontece quando a conexão cai: avisar a equipe e/ou pausar as transmissões dela.', corpo: connectionDisconnectionSchema, exemplo: { notify: true, pause_broadcasts: true } },
    { metodo: 'POST', caminho: '/api/connections/:id/enabled', resumo: 'Liga (`enabled: true`) ou desliga (`enabled: false`) a conexão; desligada, ela não recebe nem envia mensagens.', corpo: enabledSchema, exemplo: { enabled: false } },
    { metodo: 'GET', caminho: '/api/connections/:id/groups', resumo: 'Lista os grupos da conta conectada, paginados e com busca, para escolher onde um gatilho de grupo vale.', query: connectionGroupsQuerySchema },
    { metodo: 'GET', caminho: '/api/connections/:id/marketing', resumo: 'Diz se a conta está habilitada para mensagens de marketing (resposta guardada, reconsultada quando velha).' },
    { metodo: 'POST', caminho: '/api/connections/:id/marketing', resumo: 'Consulta de novo, agora, a habilitação da conta para mensagens de marketing.' },
    { metodo: 'GET', caminho: '/api/connections/:id/meta-review', resumo: 'Situação da revisão de permissões e recursos da Meta para a conexão (`items`: recurso, origem e status). Sem credencial salva: 409. Erro da Meta: código e subcódigo traduzidos (409 token, 422 recusa, 429 limite); 502 só quando a Meta não responde.' },
    { metodo: 'GET', caminho: '/api/connections/:id/posts', resumo: 'Lista as publicações da conta conectada, paginadas por `after`. Recusa da Meta chega com código e subcódigo. Conexão sem credencial salva: 409 "sem credencial salva, cole o token de novo".', query: connectionPageQuerySchema },
    { metodo: 'POST', caminho: '/api/connections/:id/refresh', resumo: 'Revalida credenciais e permissões da conexão e reassina o webhook automático. `ok` e `detail` dizem o resultado; sem credencial salva, `detail` pede para colar o token de novo (a conexão vai para erro).' },
    { metodo: 'POST', caminho: '/api/connections/:id/rotate', resumo: 'Troca as credenciais da conexão (ex.: token novo) e registra o webhook de novo (WhatsApp oficial: no número, com o token de verificação atual).', corpo: connectionRotateSchema, exemplo: { credentials: { botToken: 'NOVO_TOKEN_AQUI' } } },
    { metodo: 'GET', caminho: '/api/connections/:id/routing', resumo: 'Papéis desta conexão no roteamento de conversas quando vários parceiros dividem o número.' },
    { metodo: 'PUT', caminho: '/api/connections/:id/shorten-links', resumo: 'Liga ou desliga o encurtador de links do texto nesta conexão (conta os cliques).', corpo: enabledSchema, exemplo: { enabled: true } },
    { metodo: 'GET', caminho: '/api/connections/:id/stories', resumo: 'Lista os stories da conta conectada, paginados por `after`. Recusa da Meta chega com código e subcódigo. Conexão sem credencial salva: 409 "sem credencial salva, cole o token de novo".', query: connectionPageQuerySchema },
    { metodo: 'POST', caminho: '/api/connections/:id/thread-control', resumo: 'Passa, libera ou toma o controle de uma conversa entre parceiros do mesmo número.', corpo: threadControlSchema, exemplo: { action: 'pass', external_user_id: '+5511912345678', target_role: 'customer_service' } },
    { metodo: 'GET', caminho: '/api/connections/:id/username', resumo: 'Lê o nome de usuário do número na API oficial do WhatsApp.' },
    { metodo: 'POST', caminho: '/api/connections/:id/username', resumo: 'Define o nome de usuário do número. Corpo `{ "username": "..." }`, com 3 a 35 letras, números, ponto ou sublinhado. Recusa da Meta (nome em uso, número sem elegibilidade): 422 com código, subcódigo e a mensagem da Meta para o usuário; token recusado 409; 502 só quando a Meta não responde.', corpo: connectionUsernameSchema, exemplo: { username: 'loja.ana' } },
    { metodo: 'DELETE', caminho: '/api/connections/:id/username', resumo: 'Remove o nome de usuário do número.' },
    { metodo: 'POST', caminho: '/api/connections/:id/webhook', resumo: 'Avança a configuração do webhook da conexão e devolve o passo atual (sem corpo). WhatsApp oficial: grava de novo o webhook no número (nunca na URL do app, que pode ser dividida com outro sistema); os avisos de conta e de modelos continuam dependendo dos campos assinados no app. Se o registro automático falhar numa conexão já conectada (ou restrita), ela não muda de estado: o webhook que o provedor já tem segue valendo e a resposta traz o passo manual com o motivo.' },
  ],
}
