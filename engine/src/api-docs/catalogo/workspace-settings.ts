import type { AreaCatalogo } from '../tipos'
import { workspaceProfileSchema, workspaceSettingsPatchSchema } from '../../workspace-settings'

// Área workspace-settings: veja em ./index.ts como preencher.
export const area: AreaCatalogo = {
  area: 'workspace-settings',
  nome: 'Configurações do espaço',
  descricao: 'Nome, fuso, foto, descrição e preferências do espaço.',
  entradas: [
    { metodo: 'GET', caminho: '/api/workspace-settings', resumo: 'Configurações gerais do espaço: nome, fuso, foto, descrição e preferências de exibição.' },
    { metodo: 'PATCH', caminho: '/api/workspace-settings', resumo: 'Altera nome, fuso, foto, descrição ou preferências de exibição do espaço (só os campos enviados).', corpo: workspaceSettingsPatchSchema, exemplo: { name: 'Loja da Ana', timezone: 'America/Sao_Paulo' } },
    { metodo: 'PUT', caminho: '/api/workspace-settings/profile', resumo: 'Grava as respostas do questionário de perfil do espaço (segmento, tamanho, canal e objetivo).', corpo: workspaceProfileSchema, exemplo: { segment: 'Varejo', size: '1-10', channel: 'instagram', goal: 'sales' } },
    { metodo: 'GET', caminho: '/api/workspace-settings/photo/:id', resumo: 'Foto do espaço (PNG, JPG ou WebP); 404 quando não existe.', respostaTipo: 'image/*' },
  ],
}
