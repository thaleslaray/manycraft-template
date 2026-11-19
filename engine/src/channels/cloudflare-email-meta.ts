import type { ProviderMeta } from './providers'

export const cloudflareEmailMeta: ProviderMeta = {
  id: 'cloudflare_email', api: { base: 'binding:EMAIL', docs: 'docs-cloudflare-email' }, kinds: ['email'], patch: {}, label: 'E-mail (Cloudflare)', live: true, contacts: 'managed', broadcast: true,
  connect: { webhook: 'manual', hook: 'connection', externalIdField: 'senderAddress', fields: [
    { key: 'senderAddress', label: 'Endereço remetente', secret: false, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$', help: 'Use o endereço padrão ou um endereço do seu domínio verificado.' },
    { key: 'senderName', label: 'Nome do remetente', secret: false, optional: true },
    { key: 'replyTo', label: 'Endereço de resposta', secret: false, optional: true },
  ], notice: 'O envio real usa o binding do Worker após verificar o domínio. Configure SPF, DKIM, DMARC e a rota de respostas no Cloudflare, e assine os eventos de envio (Event Subscription) para registrar entrega e bounce. Marketing funciona apenas na simulação local: o Email Service aceita somente mensagens transacionais.' },
  options: [
    { key: 'senderName', type: 'text', label: 'Nome do remetente', max: 200 },
    { key: 'replyTo', type: 'text', label: 'Endereço de resposta', max: 254 },
    { key: 'platformBranding', type: 'boolean', label: 'Mostrar identificação da plataforma no rodapé' },
  ],
}
