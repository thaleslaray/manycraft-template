import { unavailableMedia } from '../schemas/message-media'
import type { ProviderMeta } from './providers'

/** Ficha do provedor Z-API clássica (api.z-api.io, instâncias; WhatsApp Web por QR code). Não é a Omni. Fica em arquivo próprio para o registro
 * ganhar o provedor com uma linha. Fonte: skill docs-zapi (espelho de developer.z-api.io); avisos citados em zapi.ts.
 * LIGADO (documentado e implementado): texto, botões de resposta (send-button-list) e de link (send-button-actions, tipo URL), cliques (buttonsResponseMessage),
 * recibos de envio/entrega/leitura/falha, estado conectado/desconectado, mensagens do dono pelo celular, pareamento por QR.
 * DESLIGADO: botão de ligação (existe como tipo CALL, mas o perfil compartilhado do WhatsApp não o tem), janela de 24 h e templates (não existem no WhatsApp Web), lista de opções (send-option-list existe e não funciona em grupo, mas o adaptador
 * não a implementa), cartões/carrossel (idem), mídia de entrada e saída (a mídia recebida expira em 30 dias e nada disso foi implementado), grupos,
 * transmissão, "digitando" (delayTyping existe, sem opção no painel). Risco: conexão não oficial pode ser bloqueada (tips/best-practices). */
export const zapiMeta: ProviderMeta = {
  id: 'zapi', api: { base: 'https://api.z-api.io', docs: 'docs-zapi' }, kinds: ['whatsapp'], label: 'WhatsApp não oficial (Z-API)', live: true, contacts: 'managed', broadcast: false,
  patch: {
    media: unavailableMedia,
    remove: ['window', 'templates', 'list'],
    initiator: 'business_with_optin', identity: { key: 'phone_e164', phoneGuaranteed: false },
    // A página de botões marca tudo como funcionando, mas o próprio resumo diz que são instáveis (aviso AC-12): sempre com saída em texto.
    unstable: ['buttons', 'list', 'cards'],
    risk: { banOnColdOutreach: true },
  },
  connect: { webhook: 'auto', hook: 'connection', pairing: 'qr', fields: [
    { key: 'instanceId', label: 'ID da instância', secret: false, pattern: '^[A-Za-z0-9]{8,64}$', help: 'Está no painel da Z-API, em Instâncias.' },
    { key: 'token', label: 'Token da instância', secret: true, help: 'O token da instância, no painel da Z-API. Nunca sai do servidor.' },
    { key: 'clientToken', label: 'Token de segurança da conta (Client-Token)', secret: true, optional: true, help: 'Painel da Z-API, aba Segurança. Obrigatório se você ativou o token de segurança da conta; deixe em branco se não ativou.' }],
    notice: 'Esta conexão não é oficial. O WhatsApp pode bloquear o número, principalmente se você mandar mensagem para quem não escreveu primeiro ou enviar em volume. Prefira um número que já responde clientes e não use um número que você não pode perder.' },
}
