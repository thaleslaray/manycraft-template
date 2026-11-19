import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from './fixtures'
import { WORKSPACE, abrirMaisBlocos, escolherCanalDoPasso, api, canalE2eSql, limpezaSql, novoTag, q, sql } from './helpers'
import { encryptCredentials } from '../../engine/src/channels/core/crypto'

// Lista de opções no passo de mensagem do WhatsApp oficial: o painel só a oferece onde a ficha do canal declara lista,
// cada opção ganha uma saída no mapa e a publicação exige que todas levem a algum passo.
test('lista de opções: oferta pela ficha do canal, uma saída por opção e publicação', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'A edição é do desktop.')
  test.setTimeout(150000)
  const t = novoTag(), automation = `e2e-lista-${t}`, wa = `e2e-lista-wa-${t}`, tg = `e2e-lista-tg-${t}`
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'O ambiente local precisa apontar para HTTP falso').toBeTruthy()
  const base = catalog.development!.providerApiBase
  expect(new URL(base).hostname).toBe('127.0.0.1')
  const vars = readFileSync(resolve(import.meta.dirname, '../../engine/.dev.vars'), 'utf8')
  const version = vars.match(/^CONNECTIONS_KEK_ACTIVE=["']?(\d+)/m)![1]
  const key = vars.match(new RegExp(`^CONNECTIONS_KEK_V${version}=["']?([^\\r\\n"']+)`, 'm'))![1]
  const sealed = await encryptCredentials({ CONNECTIONS_KEK_ACTIVE: version, [`CONNECTIONS_KEK_V${version}`]: key }, { workspaceId: WORKSPACE, connectionId: wa }, { accessToken: 'TESTONLY', phoneNumberId: '123', wabaId: '456' })

  // Graph API falsa: nada de rede real; guarda o que for enviado para provar que editar e publicar não manda mensagem a ninguém.
  const posts: string[] = []
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.method === 'POST' && req.url?.endsWith('/messages')) posts.push(req.url)
      res.setHeader('content-type', 'application/json'); res.setHeader('connection', 'close')
      res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'fake-1' }] }))
    })
  })
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(Number(new URL(base).port), '127.0.0.1', ok) })

  const text = (value: string) => ({ kind: 'text', text: value })
  const message = (id: string, y: number, blocks: unknown[]) => ({ id, type: 'message', position: { x: 380, y }, config: { channel: 'whatsapp', blocks } })
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      message('menu', 0, [text('Sobre o que você quer falar?'), { kind: 'list', buttonText: 'Ver assuntos', sections: [
        { title: 'Vendas', rows: [{ id: 'l1', title: 'Preços' }, { id: 'l2', title: 'Planos', description: 'Mensal e anual' }] },
        { title: 'Ajuda', rows: [{ id: 'l3', title: 'Suporte' }] }] }]),
      message('precos', 300, [text('Segue a tabela de preços.')]),
      message('suporte', 600, [text('Chamando o suporte.')]),
    ],
    edges: [{ from: 'trigger', port: 'next', to: 'menu' }, { from: 'menu', port: 'btn:l1', to: 'precos' }, { from: 'menu', port: 'btn:l2', to: 'precos' }],
  }
  try {
    sql([
      `INSERT INTO channels(id,workspace_id,type,provider,external_id,status,connection_state,display_name,settings,credentials_ciphertext,credentials_iv,credentials_key_version) VALUES ('${wa}','${WORKSPACE}','whatsapp','meta_whatsapp_cloud','${wa}-ext','connected','connected','WhatsApp ${t}','${q(JSON.stringify({ apiBase: base }))}','${sealed.ciphertext}','${sealed.iv}',${sealed.keyVersion})`,
      ...canalE2eSql(tg, 'telegram'), `UPDATE channels SET provider='telegram_bot',connection_state='connected',display_name='Telegram ${t}' WHERE id='${tg}'`,
      `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${automation}','${WORKSPACE}','Lista ${t}','${q(JSON.stringify(graph))}')`,
      `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('${automation}-t','${WORKSPACE}','${automation}','${wa}','Menu','keyword','active','every_time','{"node_id":"trigger"}')`,
      `INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('${automation}-k','${WORKSPACE}','${automation}-t','is','["lista-${t}"]','live',0)`,
    ])
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${automation}`)

    // Cada opção tem a sua saída no cartão do passo.
    const menu = page.locator('.react-flow__node[data-id="menu"]')
    for (const titulo of ['Preços', 'Planos', 'Suporte']) await expect(menu.getByLabel(`Saída da opção ${titulo}`, { exact: true })).toHaveCount(1)

    // Publicar com uma opção sem destino é recusado, dizendo qual.
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByRole('img', { name: 'Erro: Opção “Suporte” da lista não leva a nenhum passo.' })).toBeVisible()

    // Painel: a lista tem os campos e os limites da ficha do WhatsApp.
    await menu.click()
    await expect(page.getByRole('heading', { name: 'Lista de opções', exact: true })).toBeVisible()
    await expect(page.getByLabel('Texto do botão que abre a lista')).toHaveValue('Ver assuntos')
    await expect(page.getByLabel('Título da opção 2', { exact: true })).toHaveValue('Planos')
    await expect(page.getByLabel('Descrição da opção 2 (opcional)')).toHaveValue('Mensal e anual')
    await expect(page.getByText('/ 24').first()).toBeVisible()
    // Uma lista por mensagem: o botão de adicionar outra fica travado.
    await abrirMaisBlocos(page)
    await expect(page.getByRole('button', { name: 'Lista de opções', exact: true })).toBeDisabled()

    // Ligar a última opção ao passo de suporte pelo painel e publicar.
    await page.getByRole('combobox', { name: 'Ao escolher “Suporte” vai para' }).click()
    await page.getByRole('option').last().click()
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Publicada · versão 1', { exact: true })).toBeVisible()
    const salvo = await api<{ automation: { draft_graph: { edges: { from: string; port: string; to: string }[] } } }>(`/api/automations/${automation}`)
    expect(salvo.automation.draft_graph.edges).toContainEqual({ from: 'menu', port: 'btn:l3', to: 'suporte' })

    // Depois de publicar o editor mostra a versão publicada (leitura); volta a editar para testar o limite da ficha: dez opções no total.
    await page.getByRole('button', { name: 'Editar', exact: true }).first().click()
    await menu.click()
    for (let n = 3; n < 10; n++) await page.getByRole('button', { name: 'Adicionar opção', exact: true }).first().click()
    await expect(page.getByLabel('Título da opção 10', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Adicionar opção', exact: true }).first()).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Adicionar seção', exact: true })).toBeDisabled()

    // Canal sem lista na ficha (Telegram): o painel nem oferece o bloco.
    await page.getByRole('button', { name: 'Adicionar passo', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Mensagem', exact: true }).click()
    await escolherCanalDoPasso(page, 'Telegram')
    await expect(page.getByRole('combobox', { name: 'Canal do passo', exact: true })).toContainText('Telegram')
    await expect(page.getByRole('button', { name: 'Texto', exact: true })).toBeVisible()
    await abrirMaisBlocos(page)
    await expect(page.getByRole('button', { name: 'Lista de opções', exact: true })).toHaveCount(0)
    expect(posts, 'editar e publicar não envia mensagem').toEqual([])
  } finally {
    await new Promise<void>(done => server.close(() => done()))
    sql([
      `DELETE FROM keywords WHERE id='${automation}-k'`, `DELETE FROM triggers WHERE automation_id='${automation}'`,
      `DELETE FROM automation_versions WHERE automation_id='${automation}'`, `DELETE FROM automations WHERE id='${automation}'`,
      `DELETE FROM channels WHERE id IN ('${wa}','${tg}')`, ...limpezaSql(),
    ])
  }
})
