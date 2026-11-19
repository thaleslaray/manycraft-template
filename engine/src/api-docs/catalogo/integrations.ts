import type { AreaCatalogo } from '../tipos'
import { googleSheetsConnectSchema, googleSheetsExportSchema } from '../../google-sheets'
import { hotmartSettingsSchema } from '../../hotmart'

// Área integrations: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'integrations',
  nome: 'Integrações',
  descricao: 'Ligações com serviços de fora, como o Google Sheets.',
  entradas: [
    { metodo: 'GET', caminho: '/api/integrations/google-sheets', resumo: 'Diz se o Google Sheets está conectado e com qual e-mail de conta de serviço.' },
    { metodo: 'PUT', caminho: '/api/integrations/google-sheets', resumo: 'Conecta o Google Sheets colando o JSON da conta de serviço (testado antes de salvar).', corpo: googleSheetsConnectSchema, exemplo: { service_account: '{"client_email":"robo@projeto.iam.gserviceaccount.com","private_key":"SUA_CHAVE_PRIVADA_AQUI"}' } },
    { metodo: 'DELETE', caminho: '/api/integrations/google-sheets', resumo: 'Desconecta o Google Sheets e apaga a conta de serviço guardada.' },
    { metodo: 'POST', caminho: '/api/integrations/google-sheets/export-contacts', resumo: 'Exporta até 5.000 contatos para uma aba da planilha (cabeçalho + uma linha por contato).', corpo: googleSheetsExportSchema, exemplo: { spreadsheet_id: '1AbCdEfGhIjKlMnOpQrStUv', sheet: 'Contatos' } },
    { metodo: 'GET', caminho: '/api/integrations/hotmart', resumo: 'Estado da integração Hotmart; a URL do webhook só aparece para quem gerencia a equipe.' },
    { metodo: 'PUT', caminho: '/api/integrations/hotmart', resumo: 'Configura a Hotmart: grava o hottok (`null` limpa) e, com `rotate`, troca a URL do webhook.', corpo: hotmartSettingsSchema, exemplo: { hottok: 'SEU_HOTTOK_AQUI' } },
  ],
}
