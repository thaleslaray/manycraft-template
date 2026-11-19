#!/usr/bin/env node
// Dados para fotografar as telas na mesma forma dos prints do original (repintura, ficha 15).
// Roda sobre o banco do db:e2e:  DEV_STATE_PATH=/pasta/estado npm run db:e2e && DEV_STATE_PATH=/pasta/estado node scripts/seed-paridade.mjs
// Só inventa dados locais (pessoas, tags e textos fictícios); nunca toca engine/.wrangler/state.
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { estadoDoAmbiente, wranglerLocal } from './estado-local.mjs'

const estado = estadoDoAmbiente('(pasta criada por npm run db:e2e)')

const W = 'demo-workspace'
const q = v => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`
const j = v => q(JSON.stringify(v))
const now = Date.now()
const min = 60_000, hora = 3_600_000, dia = 86_400_000
const out = ['PRAGMA foreign_keys = OFF;']
const sql = s => out.push(s)

// Fotos: rostos inventados (ilustração desenhada pixel a pixel, nenhuma pessoa real), PNG embutido como data URI.
// O envio de verdade só aceita PNG, JPG e WebP até 2 MB; estes têm menos de 2 KB.
function crc32(buf) { let c, crc = ~0; for (const byte of buf) { c = (crc ^ byte) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c } return ~crc >>> 0 }
function chunk(tipo, dados) { const t = Buffer.from(tipo), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(dados.length); crc.writeUInt32BE(crc32(Buffer.concat([t, dados]))); return Buffer.concat([len, t, dados, crc]) }
function png(lado, cor) {
  const linhas = Buffer.alloc((lado * 3 + 1) * lado)
  for (let y = 0; y < lado; y++) for (let x = 0; x < lado; x++) {
    const [r, g, b] = cor(x, y, lado), o = y * (lado * 3 + 1) + 1 + x * 3
    linhas[o] = r; linhas[o + 1] = g; linhas[o + 2] = b
  }
  const cab = Buffer.alloc(13); cab.writeUInt32BE(lado, 0); cab.writeUInt32BE(lado, 4); cab[8] = 8; cab[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', cab), chunk('IDAT', deflateSync(linhas)), chunk('IEND', Buffer.alloc(0))])
}
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const fundos = ['#d8d2c5', '#d6cfe6', '#cfe0d8', '#e6d8cf', '#d9d6cf', '#e0d3b8'].map(hex)
const peles = ['#f1c8a5', '#e0a97f', '#c68642', '#8d5524', '#f6d7b8', '#a86b3c'].map(hex)
const cabelos = ['#2b1d14', '#5a3825', '#9a6b32', '#161616', '#b8862f', '#6e6e6e', '#7a2e1d'].map(hex)
const roupas = ['#c9702a', '#d9534f', '#3a9d6a', '#7b5fd1', '#e0933a', '#35495e'].map(hex)
const dentro = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
function rosto(n) {
  const fundo = fundos[n % 6], pele = peles[(n * 5) % 6], cabelo = cabelos[(n * 3) % 7], roupa = roupas[(n * 7) % 6], longo = n % 3 === 0, olho = [40, 36, 40]
  return png(96, (x, y) => {
    if (dentro(x, y, 39, 44, 2.6, 2.6) || dentro(x, y, 57, 44, 2.6, 2.6)) return olho
    if (y >= 55 && y <= 57 && x >= 42 && x <= 54 && dentro(x, y, 48, 52, 8, 5)) return [176, 82, 82]
    if (dentro(x, y, 48, 44, 20, 25)) return y < 30 + Math.abs(x - 48) / 4 ? cabelo : pele
    if (longo && x > 24 && x < 72 && y > 30 && y < 74 && (dentro(x, y, 48, 46, 26, 30) && !dentro(x, y, 48, 46, 20, 28))) return cabelo
    if (dentro(x, y, 48, 24, 22, 14) && y < 32) return cabelo
    if (x > 41 && x < 55 && y > 66 && y < 78) return pele
    if (dentro(x, y, 48, 104, 38, 32)) return roupa
    return fundo
  })
}
const avatar = n => 'data:image/png;base64,' + rosto(n).toString('base64')
const FOTO_CONTA = png(160, (x, y, lado) => {
  const d = Math.hypot(x - lado / 2, y - lado / 2), anel = d > lado * 0.29 && d < lado * 0.4
  return anel ? [255, 255, 255] : [0xff, 0x4d, 0x00]
})

sql(`UPDATE workspaces SET profile_answers=${j({ goal: 'leads', segment: 'Serviços', size: '2 a 10 pessoas', channel: 'Instagram' })} WHERE id=${q(W)};`)
// ---------- Equipe (7 pessoas, como a lista da caixa de entrada) ----------
const equipe = [
  ['demo-user', 'Lia Exemplo', null],
  ['eq-marina', 'Marina Castro', 'eq-m'], ['eq-otavio', 'Otávio Prado', 'eq-o'], ['eq-helena', 'Helena Duarte', 'eq-h'],
  ['eq-caue', 'Cauê Barreto', 'eq-c'], ['eq-renata', 'Renata Vidal', 'eq-r'], ['eq-bruno', 'Bruno Siqueira', 'eq-b'],
]
equipe.forEach(([id, nome], i) => {
  if (i > 0) {
    sql(`INSERT OR IGNORE INTO "user"(id,name,email,emailVerified,image,createdAt,updatedAt) VALUES (${q(id)},${q(nome)},${q(id + '@example.test')},1,${q(avatar(i))},datetime('now'),datetime('now'));`)
    sql(`INSERT OR IGNORE INTO workspace_members(id,workspace_id,user_id,role,inbox_seat) VALUES (${q('m-' + id)},${q(W)},${q(id)},'administrator',1);`)
  }
})
sql(`UPDATE "user" SET image=${q(avatar(0))} WHERE id='demo-user';`)
sql(`UPDATE workspace_members SET inbox_seat=1 WHERE id='demo-owner';`)
// Papéis da equipe: 1 dono, 2 administradores, 2 editores e 2 agentes de chat (os quatro grupos do original).
const papeis = { 'eq-marina': 'administrator', 'eq-otavio': 'administrator', 'eq-helena': 'editor', 'eq-caue': 'editor', 'eq-renata': 'livechat_agent', 'eq-bruno': 'livechat_agent' }
for (const [id, papel] of Object.entries(papeis)) sql(`UPDATE workspace_members SET role=${q(papel)}, inbox_seat=1 WHERE id=${q('m-' + id)};`)
// Foto e descrição da conta (campos do ticket 04). O arquivo da foto vai para o R2 local no fim do script.
const fotoId = '6f1c2a3e-5b7d-4e8f-9a0b-1c2d3e4f5a6b'
sql(`INSERT OR REPLACE INTO media_objects(id,workspace_id,object_key,content_type,size,created_at) VALUES (${q(fotoId)},${q(W)},'seed-paridade/foto-da-conta.png','image/png',${FOTO_CONTA.length},${now});`)
sql(`UPDATE workspaces SET photo_media_id=${q(fotoId)}, description=${q('Oficina de bicicletas elétricas em São Paulo. Atendemos por Instagram e WhatsApp, de segunda a sábado.')} WHERE id=${q(W)};`)

// ---------- Canais: cinco conectados ----------
sql(`UPDATE channels SET display_name='Instagram da oficina' WHERE type='instagram';`)
sql(`INSERT OR IGNORE INTO channels(id,workspace_id,type,external_id,status,display_name) VALUES ('ch-whatsapp',${q(W)},'whatsapp','5511900000000','connected','WhatsApp da oficina');`)
sql(`INSERT OR IGNORE INTO channels(id,workspace_id,type,external_id,status,display_name) VALUES ('ch-messenger',${q(W)},'messenger','pagina-inventada-1','connected','Página da oficina');`)
sql(`INSERT OR IGNORE INTO channels(id,workspace_id,type,provider,external_id,status,display_name) VALUES ('ch-email',${q(W)},'email','cloudflare_email','oficina.example.test','connected','E-mail da oficina');`)

// ---------- Contatos: 4.200 (42 desenhados à mão no topo da lista, dois terços com foto; o resto gerado, sem foto) ----------
const nomes = ['Ester Valadares', 'Alison Moreira', 'Adriano Rocha', 'Letícia Nunes', 'Mendes Sandoval Alves', 'Daniele Andrade', 'Ivan Leal', 'Bianca Freitas', 'Rafael Quintão', 'Sofia Lacerda',
  'Tiago Marinho', 'Carla Peixoto', 'Murilo Teixeira', 'Patrícia Brandão', 'Vinícius Camargo', 'Aline Sampaio', 'Gustavo Pires', 'Joana Falcão', 'Heitor Moura', 'Yasmin Cordeiro',
  'Elias Tavares', 'Mônica Resende', 'Felipe Arantes', 'Isabela Corrêa', 'Rogério Melo', 'Camila Duarte', 'Lucas Bittencourt', 'Valéria Pinheiro', 'André Soares', 'Nicole Batista',
  'Caio Mendonça', 'Larissa Teles', 'Otto Guedes', 'Priscila Neves', 'Davi Rangel', 'Clarice Antunes', 'Samuel Veloso', 'Renata Aguiar', 'Hugo Barbosa', 'Marta Lessa',
  'Igor Fontes', 'Débora Salgado']
const offsets = [1 * min, 17 * min, 1.2 * hora, 1.4 * hora, 1.6 * hora, 1.8 * hora, 2.2 * hora, 3 * hora, 5 * hora, 8 * hora]
const gen = ['', '', 'female', 'male']
const comFoto = i => i % 3 === 0 || i % 2 === 0
nomes.forEach((nome, i) => {
  const [primeiro, ...resto] = nome.split(' ')
  const t = now - (offsets[i] ?? (10 + i) * hora)
  const status = i % 11 === 5 ? 'unsubscribed' : 'subscribed'
  // Origem: um quarto vem de widgets e um quarto de anúncios (gatilhos tr-w* e tr-ad*, criados abaixo); alimenta a lateral de Contatos.
  const origem = i % 4 === 0 ? 'trigger:tr-w' + (((i / 4) | 0) % 5) : i % 4 === 1 ? 'trigger:tr-ad' + ((((i - 1) / 4) | 0) % 5) : null
  const anuncio = i % 4 === 1
  sql(`INSERT INTO contacts(id,workspace_id,first_name,last_name,gender,profile_pic_url,subscribed_at,last_interaction_at,status,optin_source,email,phone,ad_source_id,ad_source_type,ad_headline,ad_source_url,ad_referred_at) VALUES (${q('ct-' + i)},${q(W)},${q(primeiro)},${q(resto.join(' '))},${q(gen[i % 4] || null)},${q(comFoto(i) ? avatar(i) : null)},${t},${t},${q(status)},${q(origem)},${q(i % 2 === 0 ? 'contato' + i + '@example.test' : null)},${q(i % 3 === 1 ? '55119000000' + String(i).padStart(2, '0') : null)},${q(anuncio ? 'ad-' + i : null)},${q(anuncio ? 'ad' : null)},${q(anuncio ? 'Bike elétrica com 10% de desconto' : null)},${q(anuncio ? 'https://example.test/anuncio/' + i : null)},${anuncio ? t : 'NULL'});`)
  sql(`INSERT INTO contact_channels(workspace_id,id,contact_id,channel_id,external_user_id,username,opted_in) VALUES (${q(W)},${q('cc-' + i)},${q('ct-' + i)},${q('demo-instagram')},${q('ext-' + i)},${q('usuario' + i)},1);`)
})

// O contato de exemplo (o que os prints abrem no perfil) tem telefone, e-mail e dois canais, como o do original tem a lista de "Optou pelo ...".
sql(`UPDATE contacts SET phone='5511987654321', email='nara.exemplo@example.test' WHERE id='demo-contact-1';`)
sql(`INSERT INTO contact_channels(workspace_id,id,contact_id,channel_id,external_user_id,identity_kind,phone_e164,opted_in) VALUES (${q(W)},'cc-demo-wa','demo-contact-1','ch-whatsapp','BR.nara1','bsuid','+5511987654321',1);`)
sql(`INSERT INTO contact_channels(workspace_id,id,contact_id,channel_id,external_user_id,identity_kind,opted_in) VALUES (${q(W)},'cc-demo-em','demo-contact-1','ch-email','nara.exemplo@example.test','provider_id',1);`)

const TOTAL = 4200
const primeiros = ['Ana', 'Bruno', 'Carlos', 'Daniela', 'Eduardo', 'Fernanda', 'Gabriel', 'Helena', 'Igor', 'Juliana', 'Kleber', 'Luana', 'Marcelo', 'Natália', 'Orlando', 'Paula', 'Rodrigo', 'Simone', 'Thiago', 'Úrsula',
  'Vitor', 'Wesley', 'Ximena', 'Yara', 'Zeca', 'Amanda', 'Breno', 'Cecília', 'Diego', 'Elaine', 'Fábio', 'Giovana', 'Henrique', 'Ingrid', 'Jonas', 'Kátia', 'Leandro', 'Mariana', 'Nelson', 'Olívia']
const sobrenomes = ['Almeida', 'Borges', 'Cavalcanti', 'Dias', 'Espíndola', 'Ferraz', 'Gomes', 'Hortência', 'Ibrahim', 'Junqueira', 'Klein', 'Lopes', 'Macedo', 'Nogueira', 'Oliveira', 'Pacheco', 'Queiroz', 'Ribeiro', 'Siqueira', 'Toledo',
  'Uchoa', 'Vasconcelos', 'Werneck', 'Xavier', 'Yamamoto', 'Zanetti', 'Albuquerque', 'Bastos', 'Carvalho', 'Domingues', 'Estevão', 'Figueiredo', 'Guimarães', 'Holanda', 'Inácio', 'Jardim', 'Krüger', 'Lacerda', 'Magalhães', 'Nascimento']
// Cada conexão tem um total próprio: Instagram 55%, WhatsApp 30%, Messenger 10%, e-mail 5% (os 42 primeiros ficam no Instagram).
const conexaoDe = i => i < nomes.length ? 'demo-instagram' : ['demo-instagram', 'demo-instagram', 'demo-instagram', 'demo-instagram', 'demo-instagram', 'demo-instagram', 'demo-instagram', 'demo-instagram', 'demo-instagram', 'demo-instagram', 'demo-instagram',
  'ch-whatsapp', 'ch-whatsapp', 'ch-whatsapp', 'ch-whatsapp', 'ch-whatsapp', 'ch-whatsapp', 'ch-messenger', 'ch-messenger', 'ch-email'][i % 20]
const lote = (tabela, colunas, linhas) => { for (let k = 0; k < linhas.length; k += 200) sql(`INSERT INTO ${tabela}(${colunas}) VALUES ${linhas.slice(k, k + 200).join(',')};`) }
const gerados = []
for (let i = nomes.length; i < TOTAL; i++) {
  const t = now - 3 * dia - (i - nomes.length) * 4 * min
  const ultimo = sobrenomes[(i * 13) % 40] + (i % 5 === 0 ? ' ' + sobrenomes[(i * 17 + 3) % 40] : '')
  gerados.push(`(${q('ct-' + i)},${q(W)},${q(primeiros[(i * 7) % 40])},${q(ultimo)},${q(gen[i % 4] || null)},${t},${t},${q(i % 53 === 5 ? 'unsubscribed' : 'subscribed')})`)
}
lote('contacts', 'id,workspace_id,first_name,last_name,gender,subscribed_at,last_interaction_at,status', gerados)
// A primeira página da lista (50 contatos) mostra foto na maioria: os primeiros gerados também têm rosto inventado.
for (let i = nomes.length; i < nomes.length + 30; i++) sql(`UPDATE contacts SET profile_pic_url=${q(avatar(i))} WHERE id=${q('ct-' + i)};`)
// O WhatsApp oficial exige identidade BSUID ("BR." mais letras e números); os outros canais usam o id do provedor.
lote('contact_channels', 'workspace_id,id,contact_id,channel_id,external_user_id,identity_kind,username,opted_in',
  Array.from({ length: TOTAL - nomes.length }, (_, k) => { const i = k + nomes.length; return `(${q(W)},${q('cc-' + i)},${q('ct-' + i)},${q(conexaoDe(i))},${q(conexaoDe(i) === 'ch-whatsapp' ? 'BR.seed' + i : 'ext-' + i)},${q(conexaoDe(i) === 'ch-whatsapp' ? 'bsuid' : 'provider_id')},${q('usuario' + i)},1)` }))

// ---------- Pastas de tags e de campos (grade de 4) ----------
;const pastasTags = ['Campanhas', 'Listas', 'Interesses', 'Pós-venda', 'Eventos', 'Arquivo', 'Funil de venda', 'Orgânico', 'Parceiros', 'Produtos', 'Palestras', 'Sorteios', 'Suporte', 'Indicações', 'Cursos', 'Lançamentos', 'Revisões', 'Peças', 'Clientes VIP', 'Testes', 'Newsletter', 'Webinar', 'Black Friday', 'Reativação']
pastasTags.forEach((nome, k) => sql(`INSERT INTO settings_folders(id,workspace_id,kind,name,created_at,updated_at) VALUES (${q('sf-t' + k)},${q(W)},'tags',${q(nome)},${now},${now});`))
;const pastasCampos = ['Dados pessoais', 'Compras', 'Preferências', 'Origem', 'Contato', 'Endereço', 'Bike', 'Revisões', 'Garantia', 'Pagamento', 'Entrega', 'Evento', 'Curso', 'Parceiros', 'Anúncios', 'Pesquisa', 'Suporte', 'Fidelidade', 'Documentos', 'Agenda', 'Orçamentos', 'Indicações', 'Internos', 'Arquivo', 'Promoções', 'Treinamentos', 'Pedidos', 'Oficina', 'Peças', 'Retirada', 'Perfil', 'Veículo', 'Faturamento', 'Atendimento', 'Logística', 'Garantia estendida', 'Cadastro', 'Reclamações']
pastasCampos.forEach((nome, k) => sql(`INSERT INTO settings_folders(id,workspace_id,kind,name,created_at,updated_at) VALUES (${q('sf-c' + k)},${q(W)},'fields',${q(nome)},${now},${now});`))

// ---------- Tags (12): contact_count é o número de linhas reais em contact_tags (a lateral e a lista de contatos têm de bater; o teste scripts/seed-paridade.test.mjs confere) ----------
const tags = [['campanha-2026-10', 3120, 'sf-t0'], ['lista-vip-evento', 1840, 'sf-t1'], ['lista-leads-frios', 960, 'sf-t1'], ['lista-clientes', 715, 'sf-t1'], ['lista-webinar', 402, 'sf-t4'],
  ['interesse-curso', 288, 'sf-t2'], ['pediu-orcamento', 143, 'sf-t2'], ['comprou-bike', 96, 'sf-t3'], ['indicou-amigo', 54, 'sf-t3'], ['visitou-oficina', 31, 'sf-t4'], ['campanha-2026-09', 22, 'sf-t0'], ['lista-antiga', 9, 'sf-t5']]
// Mais 28 tags pequenas: cada uma das 20 pastas tem pelo menos uma, e a lista passa de dezenas de linhas.
const nomesPasta = pastasTags.map(n => n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-'))
tags.push(['newsletter-semanal', 36, 'sf-t20'], ['webinar-2026-11', 18, 'sf-t21'], ['black-friday-2026', 64, 'sf-t22'], ['reativacao-inativos', 12, 'sf-t23'])
for (let k = 0; k < 28; k++) { const f = 6 + (k % 14); tags.push([`${nomesPasta[f]}-${k < 14 ? 'a' : 'b'}`, 4 + (k * 7) % 41, 'sf-t' + f]) }
tags.forEach(([nome, n, pasta], k) => {
  // Cada tag marca exatamente n contatos distintos (passo 11 é primo com 4.200, então nenhum se repete); o gatilho de contact_tags soma o contact_count de cada linha.
  sql(`INSERT INTO tags(id,workspace_id,name,contact_count,folder_id) VALUES (${q('tg-' + k)},${q(W)},${q(nome)},0,${q(pasta)});`)
  lote('contact_tags', 'workspace_id,contact_id,tag_id', Array.from({ length: n }, (_, c) => `(${q(W)},${q('ct-' + ((c * 11 + k * 3) % TOTAL))},${q('tg-' + k)})`))
})

// ---------- Campos personalizados (10), com pastas ----------
const campos = [['cidade', 'text', 'sf-c0'], ['data_nascimento', 'date', 'sf-c0'], ['ultima_compra', 'date', 'sf-c1'], ['valor_total_compras', 'number', 'sf-c1'], ['modelo_da_bike', 'text', 'sf-c1'],
  ['recebe_novidades', 'boolean', 'sf-c2'], ['horario_preferido', 'text', 'sf-c2'], ['origem_da_indicacao', 'text', 'sf-c3'], ['campanha_de_entrada', 'text', 'sf-c3'], ['observacao_interna', 'text', null]]
const extrasCampos = ['telefone_alternativo', 'email_secundario', 'rua', 'bairro', 'tamanho_do_quadro', 'cor_preferida', 'ultima_revisao', 'garantia_ate', 'forma_de_pagamento', 'prazo_de_entrega',
  'evento_de_interesse', 'turma', 'parceiro_de_origem', 'anuncio_de_entrada', 'nota_da_pesquisa', 'ticket_de_suporte', 'pontos_de_fidelidade', 'documento_enviado']
extrasCampos.forEach((nome, k) => campos.push([nome, ['text', 'text', 'text', 'text', 'text', 'text', 'date', 'date', 'text', 'number', 'text', 'text', 'text', 'text', 'number', 'text', 'number', 'boolean'][k], 'sf-c' + (4 + k)]))
campos.forEach(([nome, tipo, pasta], k) => {
  sql(`INSERT INTO custom_fields(id,workspace_id,scope,name,type,description,folder_id) VALUES (${q('cf-' + k)},${q(W)},'contact',${q(nome)},${q(tipo)},${q('Campo de exemplo ' + (k + 1))},${q(pasta)});`)
  for (let c = 0; c < (k < 10 ? 12 : 3); c++) {
    const v = tipo === 'number' ? 100 + c * 37 : tipo === 'boolean' ? c % 2 === 0 : tipo === 'date' ? `2026-0${1 + (c % 9)}-1${c % 9}` : nome + ' ' + c
    sql(`INSERT OR IGNORE INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES (${q(W)},${q('ct-' + ((c * 3 + k) % nomes.length))},${q('cf-' + k)},${j(v)});`)
  }
})

// ---------- Segmentos (7) ----------
const segs = ['Janela de 24h', 'Tem WhatsApp', 'Recém-inscritos', 'Leads quentes', 'Clientes ativos', 'Sem resposta', 'Evento de lançamento']
segs.forEach((nome, k) => sql(`INSERT INTO segments(id,workspace_id,name,filter) VALUES (${q('sg-' + k)},${q(W)},${q(nome)},${j({ match: 'all', rules: [{ type: 'tag', tag_id: 'tg-' + (k % tags.length), operator: 'has' }] })});`))

// ---------- Automações: 8 pastas na raiz, 3 subpastas numa, 5 automações na raiz (fluxos de 2 a 6 passos) ----------
;['0. Infraestrutura', '1. Funis de venda', '2. Orgânicos', '3. Produtos', '4. Parceiros', '5. Palestras', '6. Modelos', '7. Diversos'].forEach((nome, k) => sql(`INSERT INTO folders(id,workspace_id,name) VALUES (${q('fd-' + k)},${q(W)},${q(nome)});`))
;['Lançamento de outubro', 'Webinar', 'Recuperação'].forEach((nome, k) => sql(`INSERT INTO folders(id,workspace_id,parent_id,name) VALUES (${q('fd-1-' + k)},${q(W)},'fd-1',${q(nome)});`))
const msg = (id, x, t) => ({ id, type: 'message', position: { x, y: 0 }, config: { blocks: [{ kind: 'text', text: t }] } })
const trig = { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} }
const ligar = ids => ids.slice(1).map((to, i) => ({ from: ids[i], port: 'next', to }))
const grafo = (nodes) => ({ nodes, edges: ligar(nodes.map(n => n.id)) })
const grafos = {
  // 2 passos: gatilho e uma mensagem
  curto: grafo([trig, msg('m1', 480, 'Olá! Obrigado pelo contato, já respondemos por aqui.')]),
  // 4 passos
  medio: grafo([trig, msg('m1', 380, 'Bem-vindo! Aqui você recebe novidades da oficina.'), msg('m2', 760, 'Quer ver os modelos disponíveis esta semana?'), msg('m3', 1140, 'Responda com o modelo que mais chamou a atenção.')]),
  // 6 passos, com ação, espera e mensagens
  longo: grafo([trig,
    { id: 'acoes', type: 'action', position: { x: 380, y: 0 }, config: { actions: [{ type: 'add_tag', tag_id: 'tg-6' }] } },
    msg('m1', 760, 'Recebi o seu pedido de orçamento. Já separamos as opções.'),
    { id: 'espera', type: 'smart_delay', position: { x: 1140, y: 0 }, config: { duration: { value: 1, unit: 'hours' } } },
    msg('m2', 1520, 'Conseguiu ver as opções? Posso reservar uma visita para você.'),
    { id: 'acoes2', type: 'action', position: { x: 1900, y: 0 }, config: { actions: [{ type: 'add_tag', tag_id: 'tg-5' }] } }]),
}
const autos = [
  ['au-0', 'Convite do evento de outubro', 'stopped', 2, 1 * dia, 'fd-1', 'medio'], ['au-1', 'Atendimento: pergunta sobre a escola', 'live', 0, 120 * dia, null, 'curto'],
  ['au-2', 'Boas-vindas ao novo contato', 'live', 14, 3 * dia, null, 'medio'], ['au-3', 'Lembrete de aula ao vivo', 'draft', 0, 9 * dia, null, 'curto'],
  ['au-4', 'Resposta automática de preços', 'live', 6, 40 * dia, null, 'longo'], ['au-5', 'Pesquisa de satisfação', 'stopped', 1, 70 * dia, null, 'medio'],
  ['au-6', 'Aviso de nova turma', 'live', 3, 12 * dia, 'fd-1', 'curto'],
]
autos.forEach(([id, nome, status, , atras, pasta, tam]) => {
  const g = JSON.stringify(grafos[tam])
  sql(`INSERT INTO automations(id,workspace_id,folder_id,name,status,draft_graph,updated_at,created_at) VALUES (${q(id)},${q(W)},${q(pasta)},${q(nome)},${q(status)},${q(g)},${now - atras},${now - atras});`)
  if (status !== 'draft') sql(`INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES (${q(id + '-v1')},${q(W)},${q(id)},1,${q(g)});`)
})
sql(`UPDATE automations SET published_version_id=id||'-v1' WHERE id IN ('au-0','au-1','au-2','au-4','au-5','au-6');`)
sql(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status) VALUES ('tr-escola',${q(W)},'au-1','demo-instagram','Mensagem é escola','keyword','active');`)
sql(`INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('kw-escola',${q(W)},'tr-escola','is',${j(['escola'])},'live',1);`)
// Automações básicas (Automação › Básico): uma resposta padrão ativa no Instagram e uma boas-vindas parada no WhatsApp.
sql(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status) VALUES ('tr-basico-resposta',${q(W)},'au-1','demo-instagram','Resposta padrão','default_reply','active');`)
sql(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status) VALUES ('tr-basico-boasvindas',${q(W)},'au-2','ch-whatsapp','Mensagem de boas-vindas','welcome_message','inactive');`)
// Widgets (5) e anúncios (5): cada um com os contatos que entraram por ele (optin_source dos contatos); alimentam a lateral de Contatos.
const widgets = [['Comentário no post de lançamento', 'feed_comment'], ['Resposta a story', 'instagram_story_reply'], ['Link de referência da loja', 'messenger_ref_url'], ['Código QR do balcão', 'messenger_code'], ['Compartilhou no story', 'instagram_share_to_story_reply']]
widgets.forEach(([nome, tipo], k) => sql(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,post_scope,config) VALUES (${q('tr-w' + k)},${q(W)},'au-2',${q(tipo === 'messenger_ref_url' || tipo === 'messenger_code' ? 'ch-messenger' : 'demo-instagram')},${q(nome)},'widget',${q(tipo)},'active','every_time',${q(tipo === 'feed_comment' ? 'all' : null)},${j(tipo === 'messenger_ref_url' || tipo === 'messenger_code' ? { code: 'ref-seed-' + k } : {})});`))
const anuncios = ['Anúncio: bike elétrica urbana', 'Anúncio: revisão grátis', 'Anúncio: acessórios com desconto', 'Anúncio: seguro da bike', 'Anúncio: aluguel por hora']
anuncios.forEach((nome, k) => sql(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,config) VALUES (${q('tr-ad' + k)},${q(W)},'au-4',${q(k < 3 ? 'demo-instagram' : 'ch-whatsapp')},${q(nome)},'widget',${q(k < 3 ? 'ads' : 'ctwa_trigger')},'active','every_time',${j({})});`))
// execuções da automação (alimentam "Execuções" da lista)
autos.forEach(([id, , status, runs]) => { if (status !== 'draft') for (let r = 0; r < runs; r++) sql(`INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,status) VALUES (${q('fr-' + id + r)},${q(W)},${q('ct-' + (r % nomes.length))},${q(id + '-v1')},'done');`) })

// ---------- Sequências: 24, uma com 3 mensagens e as outras com 1; assinantes reais em cada uma ----------
const sequencias = ['Boas-vindas em 5 dias', 'Recuperação de carrinho', 'Aquecimento do evento', 'Pós-compra: primeira semana', 'Reativação de 30 dias', 'Lista de espera da turma', 'Dicas de manutenção',
  'Convite para a revisão', 'Lançamento da coleção', 'Pesquisa de satisfação', 'Indicação de amigos', 'Aviso de promoção', 'Treino iniciante', 'Material gratuito', 'Revisão de 6 meses', 'Garantia estendida', 'Convite para o clube', 'Dicas de segurança', 'Boas-vindas ao WhatsApp', 'Pesquisa de produto',
  'Reativação de inativos', 'Aviso de estoque', 'Oferta de acessórios', 'Convite para a turma da manhã']
sequencias.forEach((nome, k) => {
  sql(`INSERT INTO sequences(id,workspace_id,name) VALUES (${q('sq-' + k)},${q(W)},${q(nome)});`)
  const passos = k === 0 ? 3 : 1
  // a primeira sequência tem 1 passo com fluxo e 2 ainda sem resposta (como no original: "Criar nova resposta / Selecionar existente")
  for (let p = 1; p <= passos; p++) { const vazio = k === 0 && p > 1; sql(`INSERT INTO sequence_steps(id,workspace_id,sequence_id,automation_id,position,delay_seconds,status) VALUES (${q('ss-' + k + '-' + p)},${q(W)},${q('sq-' + k)},${vazio ? 'NULL' : q(k === 0 ? 'au-2' : ['au-2', 'au-0', 'au-6'][(k + p) % 3])},${p},${k === 0 ? 86400 : p === 1 ? 86400 : 172800},${vazio ? "'draft'" : "'live'"});`) }
  const assinantes = Math.max(5, 30 - k * 2)
  for (let c = 0; c < assinantes; c++) sql(`INSERT OR IGNORE INTO sequence_subscriptions(workspace_id,sequence_id,contact_id,next_step,next_at) VALUES (${q(W)},${q('sq-' + k)},${q('ct-' + ((c * 5 + k) % nomes.length))},0,${now + (c + 1) * hora});`)
})

// ---------- Gatilho de comentário (editor com painel aberto) ----------
const grafoComentario = {
  nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'acoes', type: 'action', position: { x: 380, y: 0 }, config: { actions: [{ type: 'add_tag', tag_id: 'tg-5' }] } },
    { id: 'm1', type: 'message', position: { x: 760, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Oi! Aqui está o material que você pediu, toque no botão para abrir.' }, { kind: 'button', id: 'abrir', label: 'Abrir material', action: { type: 'url', url: 'https://example.com/material' } }] } },
    { id: 'm2', type: 'message', position: { x: 1140, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Conseguiu abrir? Me conta se faltou alguma coisa.' }] } },
    { id: 'espera', type: 'smart_delay', position: { x: 1520, y: 0 }, config: { duration: { value: 2, unit: 'minutes' } } },
    { id: 'm3', type: 'message', position: { x: 1900, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Se precisar de ajuda, chama o nosso time por aqui.' }] } },
  ],
  edges: [['trigger', 'acoes'], ['acoes', 'm1'], ['m1', 'm2'], ['m2', 'espera'], ['espera', 'm3']].map(([from, to]) => ({ from, port: 'next', to })),
}
const gc = JSON.stringify(grafoComentario)
sql(`INSERT INTO automations(id,workspace_id,name,status,draft_graph,updated_at) VALUES ('au-comentario',${q(W)},'Perpétuo: comentário eu quero','live',${q(gc)},${now - 5 * dia});`)
sql(`INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('au-comentario-v1',${q(W)},'au-comentario',1,${q(gc)});`)
sql("UPDATE automations SET published_version_id='au-comentario-v1', folder_id='fd-2' WHERE id='au-comentario';")
// Na raiz de Minhas automações o original mostra só 5 soltas (uma linha e meia de cartões); as demais ficam em pastas.
sql("UPDATE automations SET folder_id='fd-7' WHERE folder_id IS NULL AND (name LIKE 'Telegram:%' OR name LIKE 'Instagram:%' OR name='Boas-vindas à oficina');")
sql(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,post_scope,config) VALUES ('tr-comentario',${q(W)},'au-comentario','demo-instagram','Comentário no post','widget','feed_comment','active','every_time','all',${j({ node_id: 'trigger', target: 'all', include: ['eu quero', 'euquero'], exclude: ['operação', 'plano', 'autonomia', 'escola', 'sim'], public_replies: [], like_comment: false })});`)

// Resposta pronta (a tela de Configurações da caixa mostra uma linha na tabela, como o original).
sql(`INSERT OR IGNORE INTO inbox_saved_replies(id,workspace_id,shortcut,body) VALUES ('sr-print',${q(W)},'print','Pode me mandar um print? :)');`)
// ---------- Caixa de entrada: 14 conversas, todas com foto (contatos com foto: 0, 3, 6...) ----------
const falas = ['Oi, tudo bem? Queria saber mais sobre o curso e como funciona o pagamento parcelado, vocês aceitam pix?', 'Já estou inscrito', 'Obrigada!', 'Oiiiiiii! Tudo bem? O evento começa quando? Preciso me organizar para chegar a tempo.', 'Receber agora', 'Quanto custa o plano anual? Vi um valor no anúncio mas não sei se ainda vale.', 'Dá para parcelar?', 'Pode me mandar o link de novo? Acho que o primeiro foi parar no spam e não consegui abrir.', 'Perfeito, vou testar hoje.', 'Bom dia! Vocês atendem aos sábados? Só consigo passar aí no fim de semana, depois do almoço.', 'Quero cancelar a minha inscrição', 'Funcionou, muito obrigado! Foi bem mais simples do que eu imaginava.', 'Vocês entregam em outra cidade?', 'Chegou tudo certinho, valeu pela atenção de vocês!']
falas.forEach((f, i) => {
  const t = now - (10 + i * 25) * min
  sql(`INSERT INTO conversations(id,workspace_id,contact_channel_id,status,assignee_id,unread,unread_count,last_message_at) VALUES (${q('cv-' + i)},${q(W)},${q('cc-' + i * 3)},'open',${q(i % 4 === 0 ? 'm-' + equipe[1 + (i % 6)][0] : null)},${i < 8 ? 1 : 0},${i < 8 ? 1 : 0},${t});`)
  sql(`INSERT INTO messages(workspace_id,id,conversation_id,direction,source,content,created_at) VALUES (${q(W)},${q('ms-' + i)},${q('cv-' + i)},'in','contact',${j({ text: f })},${t});`)
})

// ---------- Transmissões: 7 agendadas, 7 rascunhos e 5 no histórico (e-mail e Instagram) ----------
const dataLocal = (ms) => new Date(ms - 3 * hora).toISOString().slice(0, 16)
;['Teste do lançamento', 'Fase 4 e-mail 1', 'Lembrete de aula', 'Aviso da promoção', 'Convite para a revisão', 'Novidades de novembro', 'Pesquisa de satisfação'].forEach((nome, k) => {
  const quando = now + (k + 1) * dia + 11 * hora
  sql(`INSERT INTO broadcasts(id,workspace_id,name,channel_id,audience_filter,status,scheduled_at,scheduled_local,content,updated_at) VALUES (${q('bc-a' + k)},${q(W)},${q(nome)},'ch-email',${j({ tag: 'tg-4' })},'scheduled',${quando},${q(dataLocal(quando))},${q('Mensagem de exemplo')},${now - hora});`)
})
;['Rascunho da oferta A3', 'Rascunho da oferta A2', 'Rascunho do aviso', 'Rascunho do webinar', 'Rascunho de boas-vindas', 'Rascunho da pesquisa', 'Rascunho do convite'].forEach((nome, k) => {
  sql(`INSERT INTO broadcasts(id,workspace_id,name,channel_id,audience_filter,status,content,updated_at) VALUES (${q('bc-r' + k)},${q(W)},${q(nome)},'ch-email',${j({ tag: 'tg-4' })},'draft',${q('Rascunho')},${now - (k + 1) * dia});`)
})
// Histórico: destinatários enviados, mensagens com recibo de entrega/leitura e cliques; cada transmissão tem números diferentes.
const historico = [['Convite do webinar de outubro', 14, 12, 8, 4], ['Promoção de aniversário', 12, 11, 6, 2], ['Novidades da semana', 10, 9, 5, 1], ['Lembrete de revisão', 8, 6, 3, 0], ['Pesquisa de satisfação', 6, 5, 2, 1]]
historico.forEach(([nome, enviados, entregues, lidos, cliques], k) => {
  const id = 'bc-h' + k, t = now - (3 + k * 6) * dia
  sql(`INSERT INTO broadcasts(id,workspace_id,name,channel_id,status,scheduled_at,scheduled_local,content,sent_count,started_at,updated_at) VALUES (${q(id)},${q(W)},${q(nome)},'demo-instagram','sent',${t},${q(dataLocal(t))},${q('Olá! Temos uma novidade para você.')},${enviados},${t},${t + 5 * min});`)
  for (let c = 0; c < enviados; c++) {
    const cc = 'cc-' + c * 3, recibo = c < lidos ? 'read' : c < entregues ? 'delivered' : 'sent'
    sql(`INSERT INTO broadcast_recipients(workspace_id,broadcast_id,contact_channel_id,run_id,status,sent_at,updated_at) VALUES (${q(W)},${q(id)},${q(cc)},${q('run-' + id + '-' + c)},'sent',${t + c * 1000},${t + c * 1000});`)
    sql(`INSERT INTO messages(workspace_id,id,conversation_id,direction,source,content,created_at,delivery_status) VALUES (${q(W)},${q('ms-' + id + '-' + c)},${q('cv-' + c)},'out','broadcast',${j({ text: 'Olá! Temos uma novidade para você.', broadcast: { id, recipient: cc } })},${t + c * 1000},${q(recibo)});`)
    if (c < cliques) sql(`INSERT INTO broadcast_links(token,workspace_id,broadcast_id,contact_channel_id,button_id,target_url,clicked_at) VALUES (${q((id + '-' + c).padEnd(32, 'x'))},${q(W)},${q(id)},${q(cc)},'abrir','https://example.test/novidade',${t + hora});`)
  }
})

// Mais 135 envios antigos, para o histórico ter centenas de linhas (160 transmissões no total); cada um com os destinatários que a contagem diz.
const assuntos = ['Convite', 'Lembrete', 'Novidades', 'Promoção', 'Pesquisa', 'Aviso', 'Boas-vindas', 'Oferta', 'Resumo', 'Reativação']
const temas = ['da revisão gratuita', 'do webinar de novembro', 'da coleção de verão', 'do plano anual', 'da turma de sábado', 'do kit de acessórios', 'da semana do cliente', 'da bike elétrica urbana', 'do evento na oficina', 'do clube de benefícios']
const canaisHist = ['demo-instagram', 'ch-email', 'ch-whatsapp']
for (let g = 0; g < 135; g++) {
  const id = 'bc-g' + g, t = now - (40 + g * 2) * dia, enviados = 3 + (g % 7), nome = `${assuntos[g % 10]} ${temas[(g * 3 + 1) % 10]}${g >= 100 ? ' ' + (g - 99) : ''}`
  sql(`INSERT INTO broadcasts(id,workspace_id,name,channel_id,status,scheduled_at,scheduled_local,content,sent_count,started_at,updated_at) VALUES (${q(id)},${q(W)},${q(nome)},${q(canaisHist[g % 3])},'sent',${t},${q(dataLocal(t))},${q('Olá! Temos uma novidade para você.')},${enviados},${t},${t + 5 * min});`)
  lote('broadcast_recipients', 'workspace_id,broadcast_id,contact_channel_id,run_id,status,sent_at,updated_at',
    Array.from({ length: enviados }, (_, c) => `(${q(W)},${q(id)},${q('cc-' + c * 3)},${q('run-' + id + '-' + c)},'sent',${t + c * 1000},${t + c * 1000})`))
}

// ---------- Eventos de conversão (4) e registros (5 de cada tipo) ----------
;[['compra', 389.9], ['agendou_visita', null], ['pediu_orcamento', null], ['baixou_material', null]].forEach(([nome, valor], k) => {
  for (let r = 0; r < 3; r++) sql(`INSERT INTO conversion_events(id,workspace_id,contact_id,automation_id,run_id,event_name,value,created_at) VALUES (${q('cv-ev-' + k + '-' + r)},${q(W)},${q('ct-' + (r % nomes.length))},'au-2',${q('fr-au-2' + (k * 3 + r))},${q(nome)},${valor === null ? 'NULL' : valor + r * 40},${now - (k + r + 1) * dia});`)
})
;[['POST', '/api/automations', 201], ['PATCH', '/api/automations/au-2', 200], ['POST', '/api/broadcasts', 201], ['PUT', '/api/workspace-settings', 200], ['DELETE', '/api/tags/tg-11', 200]].forEach(([metodo, rota, status], k) =>
  sql(`INSERT INTO activity_log(workspace_id,user_id,method,path,status,created_at) VALUES (${q(W)},'demo-user',${q(metodo)},${q(rota)},${status},${now - (k + 1) * 3 * hora});`))
;[['run', 'POST', 'https://api.example.test/pedidos', 500, 'error', 'http_5xx', 'O serviço respondeu com erro.'], ['test', 'GET', 'https://api.example.test/status', 200, 'ok', null, null], ['run', 'POST', 'https://api.example.test/leads', 408, 'error', 'timeout', 'Tempo esgotado.'],
  ['test', 'POST', 'https://api.example.test/cadastro', 200, 'ok', null, null], ['run', 'GET', 'https://api.example.test/estoque', 404, 'error', 'http_4xx', 'Recurso não encontrado.'],
  ['run', 'POST', 'https://api.example.test/agenda', 500, 'error', 'http_5xx', 'O serviço respondeu com erro.'], ['run', 'GET', 'https://api.example.test/frete', 502, 'error', 'http_5xx', 'O serviço respondeu com erro.']].forEach(([origem, metodo, alvo, status, resultado, codigo, mensagem], k) =>
  sql(`INSERT INTO external_request_logs(id,workspace_id,automation_id,source,method,target,status,outcome,error_code,message,duration_ms,created_at) VALUES (${q('erl-' + k)},${q(W)},'au-2',${q(origem)},${q(metodo)},${q(alvo)},${status},${q(resultado)},${q(codigo)},${q(mensagem)},${120 + k * 90},${now - (k + 1) * 5 * hora});`))
// Modelos instalados (Configurações › Modelos instalados): cada modelo aplicado, por quem e a automação que gerou.
const instalados = [['boas-vindas', 'au-2', 'eq-marina', 12 * dia], ['link-palavra', 'au-4', 'demo-user', 20 * dia], ['horarios', 'au-3', 'demo-user', 34 * dia], ['endereco', 'au-6', 'eq-otavio', 48 * dia], ['agendamento', 'au-5', 'demo-user', 75 * dia], ['ajuda', 'au-1', 'eq-helena', 110 * dia]]
// Mais 11 instalações dos mesmos seis modelos (o catálogo tem seis), para a lista ter a forma do original: 17 linhas.
const quemInstala = ['demo-user', 'eq-marina', 'eq-otavio', 'eq-helena', 'eq-caue']
const modelosCatalogo = ['boas-vindas', 'link-palavra', 'horarios', 'endereco', 'agendamento', 'ajuda']
for (let k = 0; k < 11; k++) instalados.push([modelosCatalogo[(k + 2) % 6], ['au-0', 'au-1', 'au-2', 'au-3', 'au-4', 'au-5', 'au-6', 'au-comentario'][k % 8], quemInstala[k % 5], (130 + k * 17) * dia])
instalados.forEach(([modelo, auto, quem, atras], k) => sql(`INSERT INTO template_installs(id,workspace_id,template_id,template_version,automation_id,user_id,installed_at) VALUES (${q('ti-' + k)},${q(W)},${q(modelo)},1,${q(auto)},${q(quem)},${now - atras});`))
// Chave de API ativa (só o hash e o final; o valor é fictício) e 8 aplicativos instalados (Configurações › API e Aplicativos).
sql(`INSERT INTO api_keys(id,workspace_id,hash,last4,created_by,created_at) VALUES ('ak-seed',${q(W)},'seed-paridade-hash-fictício-0001','7f3a','demo-user',${now - 30 * dia});`)
;['Consulta de CEP', 'Agenda da oficina', 'Planilha de pedidos', 'Cotação de frete', 'Estoque de peças', 'Cadastro de clientes', 'Avisos por e-mail', 'Pesquisa de satisfação'].forEach((nome, k) => {
  const spec = { name: nome, version: `1.${k % 4}`, actions: [{ name: 'consultar', label: 'Consultar', form: [], requests: [{ method: 'GET', url: 'https://api.example.test/' + k, headers: {} }], mapping: [] }], triggers: [], sources: {} }
  sql(`INSERT INTO installed_apps(id,workspace_id,name,spec,installed_by,created_at) VALUES (${q('app-' + k)},${q(W)},${q(nome)},${j(spec)},'demo-user',${now - (5 + k * 9) * dia});`)
})
// Toda transmissão grava o fluxo, pela mesma regra da migração 0115 (o conteúdo abre no mapa, não no formulário antigo).
const migracaoFluxo = await readFile(new URL('../migrations/0115_transmissao_como_fluxo.sql', import.meta.url), 'utf8')
sql(migracaoFluxo.slice(migracaoFluxo.indexOf('UPDATE broadcasts')).trim())
sql('PRAGMA foreign_keys = ON;')

if (process.argv.includes('--sql')) { process.stdout.write(out.join('\n') + '\n', () => process.exit(0)); await new Promise(() => {}) }
const dir = await mkdtemp(join(tmpdir(), 'replica-seed-paridade-'))
try {
  const arquivo = join(dir, 'seed-paridade.sql')
  await writeFile(arquivo, out.join('\n') + '\n', { mode: 0o600 })
  wranglerLocal(estado, 'd1', 'execute', 'DB', '--file', arquivo)
  // A foto da conta precisa existir no R2 local para a rota /api/workspace-settings/photo/:id devolvê-la.
  const foto = join(dir, 'foto-da-conta.png')
  await writeFile(foto, FOTO_CONTA)
  wranglerLocal(estado, 'r2', 'object', 'put', 'replica-media/seed-paridade/foto-da-conta.png', '--file', foto, '--content-type', 'image/png')
  console.log('dados de paridade prontos em', estado)
} finally { await rm(dir, { recursive: true, force: true }) }
