import type { AreaCatalogo } from '../tipos'
import { emailDraftSchema, emailContactPatchSchema, emailDevEventSchema, emailDevInboundSchema, emailDraftAutomationNodeSchema, emailMarketingProviderSchema, emailSenderVerifySchema, emailSettingsPatchSchema, emailTestSchema, emailSenderPatchSchema, emailSenderSchema } from '../../email-channel/routes'
import { emailRuleSchema, emailRulePatchSchema, emailSegmentSchema, emailStopSchema } from '../../email-channel/management'

const filtro = { match: 'all', rules: [] }

export const area: AreaCatalogo = {
  area: 'email',
  nome: 'E-mail',
  descricao: 'Canal de e-mail: remetente, domínio, envios e respostas.',
  entradas: [
    { metodo: 'GET', caminho: '/api/email/settings', resumo: 'Mostra as configurações de e-mail: remetentes, remetente padrão, dados da empresa, pausa e limites de rejeição.' },
    { metodo: 'PATCH', caminho: '/api/email/settings', resumo: 'Altera remetente padrão, dados da empresa, pausa dos envios ou limites de rejeição, descadastro e reclamação.', corpo: emailSettingsPatchSchema, exemplo: { company: { name: 'Loja Exemplo', address: 'Rua A, 100, São Paulo - SP' } } },
    { metodo: 'POST', caminho: '/api/email/senders', resumo: 'Cadastra um remetente com endereço do domínio da empresa (provedores gratuitos são recusados).', corpo: emailSenderSchema, exemplo: { address: 'contato@exemplo.com', name: 'Loja Exemplo' } },
    { metodo: 'PATCH', caminho: '/api/email/senders/:id', resumo: 'Altera nome, resposta-para e marca do remetente, ou o define como padrão (só verificado).', corpo: emailSenderPatchSchema, exemplo: { name: 'Equipe Exemplo', isDefault: true } },
    { metodo: 'POST', caminho: '/api/email/senders/:id/verify', resumo: 'Avança a verificação do remetente: endereço, DNS do domínio ou reenvio do e-mail de verificação.', corpo: emailSenderVerifySchema, exemplo: { stage: 'dns' } },
    { metodo: 'GET', caminho: '/api/email/drafts', resumo: 'Lista os rascunhos de e-mail salvos.' },
    { metodo: 'POST', caminho: '/api/email/drafts', resumo: 'Salva (ou atualiza, com `id`) um rascunho de e-mail.', corpo: emailDraftSchema, exemplo: { name: 'Boas-vindas', subject: 'Bem-vinda!', text: 'Oi, que bom ter você aqui.' } },
    { metodo: 'POST', caminho: '/api/email/drafts/:id/automation-node', resumo: 'Copia o rascunho para um passo de uma automação.', corpo: emailDraftAutomationNodeSchema, exemplo: { automationId: 'auto-1', nodeId: 'node-1' } },
    { metodo: 'POST', caminho: '/api/email/test', resumo: 'Envia um e-mail de teste para um endereço (exige `consent: true`).', corpo: emailTestSchema, exemplo: { to: 'ana@exemplo.com', subject: 'Teste', text: 'Olá!', consent: true } },
    { metodo: 'GET', caminho: '/api/email/contacts/:id', resumo: 'Mostra o e-mail do contato, a inscrição no marketing por e-mail e o histórico de mensagens.' },
    { metodo: 'PATCH', caminho: '/api/email/contacts/:id', resumo: 'Altera o e-mail do contato ou a inscrição dele no marketing por e-mail.', corpo: emailContactPatchSchema, exemplo: { address: 'ana@exemplo.com', optedIn: true, consent: true } },
    { metodo: 'GET', caminho: '/api/email/metrics', resumo: 'Números dos e-mails enviados (entregues, aberturas, cliques, rejeições, descadastros); `broadcastId` na query limita a uma transmissão.' },
    { metodo: 'GET', caminho: '/api/email/rules', resumo: 'Lista as regras de e-mail (evento que inicia uma automação).' },
    { metodo: 'POST', caminho: '/api/email/rules', resumo: 'Cria uma regra que inicia uma automação quando o e-mail é definido, aberto, clicado ou o contato é criado.', corpo: emailRuleSchema, exemplo: { name: 'Abriu o e-mail', event: 'email_opened', automationId: 'auto-1', active: true, filter: filtro } },
    { metodo: 'PATCH', caminho: '/api/email/rules/:id', resumo: 'Altera campos da regra de e-mail.', corpo: emailRulePatchSchema, exemplo: { active: false } },
    { metodo: 'DELETE', caminho: '/api/email/rules/:id', resumo: 'Manda a regra de e-mail para a lixeira.' },
    { metodo: 'GET', caminho: '/api/email/segments', resumo: 'Lista os segmentos de e-mail (filtros de contato salvos).' },
    { metodo: 'POST', caminho: '/api/email/segments', resumo: 'Cria um segmento de e-mail com nome e filtro de contatos.', corpo: emailSegmentSchema, exemplo: { name: 'Todos', filter: filtro } },
    { metodo: 'GET', caminho: '/api/email/segments/:id', resumo: 'Mostra o segmento de e-mail com o filtro.' },
    { metodo: 'DELETE', caminho: '/api/email/segments/:id', resumo: 'Exclui o segmento de e-mail.' },
    { metodo: 'GET', caminho: '/api/email/connections/:id/stop', resumo: 'Mostra a resposta de descadastro da conexão de e-mail (assunto, texto, automação).' },
    { metodo: 'PUT', caminho: '/api/email/connections/:id/stop', resumo: 'Define a resposta de descadastro da conexão de e-mail e a automação opcional que roda junto.', corpo: emailStopSchema, exemplo: { subject: 'Descadastro confirmado', text: 'Você não receberá mais e-mails de marketing.', enabled: true, automationId: null } },
    { metodo: 'GET', caminho: '/api/email/marketing-provider', resumo: 'Diz se há chave do provedor de marketing (Resend) configurada.' },
    { metodo: 'PUT', caminho: '/api/email/marketing-provider', resumo: 'Grava a chave do Resend usada nos envios de marketing.', corpo: emailMarketingProviderSchema, exemplo: { api_key: 're_xxxxxxxxxxxx' } },
    { metodo: 'DELETE', caminho: '/api/email/marketing-provider', resumo: 'Remove a chave do provedor de marketing.' },
    { metodo: 'GET', caminho: '/api/email/dev/outbox', soDesenvolvimento: true, resumo: 'Só em desenvolvimento: lista os e-mails que seriam enviados.' },
    { metodo: 'POST', caminho: '/api/email/dev/inbound', soDesenvolvimento: true, resumo: 'Só em desenvolvimento: simula a resposta de um contato a um e-mail.', corpo: emailDevInboundSchema, exemplo: { from: 'ana@exemplo.com', to: 'reply+abc@exemplo.com', messageId: '<m1@exemplo.com>', text: 'Quero saber mais.' } },
    { metodo: 'POST', caminho: '/api/email/dev/events', soDesenvolvimento: true, resumo: 'Só em desenvolvimento: simula entrega, rejeição ou reclamação de um e-mail enviado.', corpo: emailDevEventSchema, exemplo: { id: 'msg-1', type: 'delivered' } },
  ],
}
