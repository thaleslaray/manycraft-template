// Catálogo da documentação da API (OpenAPI 3.1, servida em GET /api/docs e /api/docs/openapi.json).
//
// O CATÁLOGO É COMPLETO: toda rota liberada para a chave (engine/src/api-rotas-liberadas.ts) tem entrada aqui.
// Rota nova liberada no motor: documente na mesma mudança; o check (`node scripts/api-inventario.mjs`, parte do
// `npm run check`) falha com rota liberada sem entrada, entrada repetida, órfã ou na área errada, e área sem
// nome ou descrição. Não há lista de pendências.
//
// COMO DOCUMENTAR UMA ROTA
// Cada área (a 2ª parte do caminho: /api/<área>/...) tem um arquivo próprio nesta pasta, com `nome` (pt-BR, vira a
// tag no documento), `descricao` (uma frase) e `entradas`. Mexa só no arquivo da área; este index importa todas.
//  1. Ache o handler (grep pelo caminho sem o `/api`, ex.: `'/contacts/:id'`).
//  2. Escreva uma entrada: { metodo, caminho, resumo, corpo?, query?, exemplo?, resposta?, respostaTipo?, soDesenvolvimento? }.
//     - `resumo`: UMA frase em pt-BR dizendo o que a rota faz e, quando não for óbvio, qual campo manda.
//     - `corpo` / `query`: o schema zod que o handler valida. Se estiver inline (`z.object({...}).parse(...)`),
//       extraia para uma constante EXPORTADA com nome descritivo `<coisa><Ação>Schema` no módulo do handler
//       (ex.: `export const contactPatchSchema = ...`), troque o handler para usá-la (o MESMO objeto, sem mudar
//       comportamento) e importe aqui. Handler que lê o corpo à mão: crie um schema que aceite e recuse
//       exatamente o mesmo, passe o handler a usá-lo e teste. Só fica sem `corpo` o schema montado no meio do
//       handler a partir de dados do pedido; nesse caso descreva os campos no resumo.
//       Não importe de `../../index` (ciclo): mova o schema para o módulo da área.
//     - `exemplo`: corpo de exemplo realista e válido (recomendado quando há `corpo`).
//     - `resposta`: schema zod do JSON de sucesso, SÓ para o documento (vira `responses.200`; o handler não valida a saída). Escreva
//       lendo o handler e as consultas, nunca pelo nome da rota. Use `z.object` (fica aberto: campo não listado pode vir, sem `strict`),
//       descreva os campos estáveis e úteis, com `.describe()` em pt-BR onde não é óbvio (unidade, formato de data, enumeração) e
//       sempre a paginação (`next_cursor`, `total`...). Datas ISO com `dataIso()`; pedaços comuns em ../respostas-comuns.ts. Toda rota com
//       `resposta` precisa de chamada em engine/test/api-docs-respostas.test.ts, que chama a rota e confere o corpo real contra o schema
//       (ou do motivo em `semChamada`); o teste falha se faltar.
//     - `respostaTipo`: só quando a resposta não é JSON (ex.: `image/jpeg`).
//     - `soDesenvolvimento: true`: rota que só existe em desenvolvimento; fica no catálogo mas fora do documento.
//  3. Rode `node scripts/api-inventario.mjs`: grava .scratch/api-docs/openapi.json. Veja o resultado em /api/docs.
//  Modelo pronto: ./contacts.ts. Rota "só no painel" (API_KEY_BLOCKED) não entra no catálogo.
import type { AreaCatalogo } from '../tipos'
import { area as activityLog } from './activity-log'
import { area as agency } from './agency'
import { area as apps } from './apps'
import { area as automationLibrary } from './automation-library'
import { area as automationTemplates } from './automation-templates'
import { area as automations } from './automations'
import { area as basic } from './basic'
import { area as broadcasts } from './broadcasts'
import { area as compliance } from './compliance'
import { area as connections } from './connections'
import { area as contactFacets } from './contact-facets'
import { area as contactImports } from './contact-imports'
import { area as contacts } from './contacts'
import { area as dashboard } from './dashboard'
import { area as email } from './email'
import { area as externalRequests } from './external-requests'
import { area as fields } from './fields'
import { area as folders } from './folders'
import { area as imports } from './imports'
import { area as inbox } from './inbox'
import { area as insights } from './insights'
import { area as integrations } from './integrations'
import { area as keywords } from './keywords'
import { area as me } from './me'
import { area as media } from './media'
import { area as messageTemplates } from './message-templates'
import { area as notices } from './notices'
import { area as notificationTopics } from './notification-topics'
import { area as pixel } from './pixel'
import { area as quickAutomations } from './quick-automations'
import { area as rules } from './rules'
import { area as segments } from './segments'
import { area as sequences } from './sequences'
import { area as settingsFolders } from './settings-folders'
import { area as siteWidgets } from './site-widgets'
import { area as tags } from './tags'
import { area as team } from './team'
import { area as triggers } from './triggers'
import { area as workspaceSettings } from './workspace-settings'
import { area as workspaces } from './workspaces'
export { area as v1 } from './public-v1'

export const AREAS: AreaCatalogo[] = [
  activityLog, agency, apps, automationLibrary, automationTemplates, automations, basic, broadcasts, compliance, connections,
  contactFacets, contactImports, contacts, dashboard, email, externalRequests, fields, folders, imports, inbox, insights,
  integrations, keywords, me, media, messageTemplates, notices, notificationTopics, pixel, quickAutomations, rules, segments,
  sequences, settingsFolders, siteWidgets, tags, team, triggers, workspaceSettings, workspaces,
]
