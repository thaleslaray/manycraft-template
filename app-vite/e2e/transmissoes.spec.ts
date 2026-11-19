import { mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { encryptCredentials } from '../../engine/src/channels/core/crypto'
import { resolve } from 'node:path'
import { test, expect } from './fixtures'
import { ENGINE, WORKSPACE, acaoDoTopo, adicionarCondicao, api, caminhoPrint, consulta, escolher, novoTag, q, sql, pastaPrints, textoDoPasso } from './helpers'
import { subirTelegramFalso } from './telegram-falso'

test('copia automação, testa, envia para elegíveis do segmento e mede clique único', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(120_000)
  await page.setViewportSize(info.project.name === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 })
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'Provedor falso obrigatório nesta jornada').toBeTruthy()
  expect(new URL(catalog.development!.providerApiBase).hostname).toBe('127.0.0.1')
  const t = novoTag(), botId = 9200000 + Math.floor(Math.random() * 500000), token = `${botId}:E2E-${t}`
  const fake = await subirTelegramFalso(Number(new URL(catalog.development!.providerApiBase).port), { [token]: { id: botId, username: `broadcast_${t}` } })
  const automation = `e2e-bc-auto-${t}`, tag = `e2e-bc-tag-${t}`, name = `Convite da comunidade ${t}`, text = `Olá, comunidade ${t}`
  let connection = '', segment = '', broadcast = ''
  try {
    const connected = await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', displayName: `Bot de transmissões ${t}`, credentials: { botToken: token } }) })
    connection = connected.connection.id
    const graph = { nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      { id: 'hello', type: 'message', position: { x: 300, y: 0 }, config: { blocks: [{ kind: 'text', text }, { kind: 'button', id: 'details', label: 'Ver detalhes', action: { type: 'go_to_node' } }, { kind: 'button', id: 'site', label: 'Abrir site', action: { type: 'url', url: 'https://example.test/comunidade' } }] } },
      { id: 'details', type: 'message', position: { x: 600, y: 0 }, config: { blocks: [{ kind: 'text', text: `Detalhes ${t}` }] } },
    ], edges: [{ from: 'trigger', port: 'next', to: 'hello' }, { from: 'hello', port: 'btn:details', to: 'details' }] }
    sql([
      `INSERT INTO tags(id,workspace_id,name) VALUES ('${tag}','${WORKSPACE}','Comunidade ${t}')`,
      `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${automation}','${WORKSPACE}','${name}','${q(JSON.stringify(graph))}')`,
      ...[1, 2, 3].flatMap(i => [
        `INSERT INTO contacts(id,workspace_id,first_name) VALUES ('e2e-bc-${t}-${i}','${WORKSPACE}','Pessoa ${i}')`,
        `INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('e2e-bc-${t}-${i}-cc','${WORKSPACE}','e2e-bc-${t}-${i}','${connection}','${5501000 + i}',${i === 2 ? 0 : 1})`,
        ...(i < 3 ? [`INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES ('${WORKSPACE}','e2e-bc-${t}-${i}','${tag}')`] : []),
      ]),
    ])
    segment = (await api<{ id: string }>('/api/segments', { method: 'POST', body: JSON.stringify({ name: `Comunidade ${t}`, filter: { match: 'all', rules: [{ type: 'tag', tag_id: tag, operator: 'has' }] } }) })).id
    await page.goto(`/${WORKSPACE}/broadcasts`)
    await acaoDoTopo(page, 'Transmissão a partir de uma automação')
    // "A partir de automação" é o pop-up Escolher existente: lista com busca, prévia e escolha; nenhum seletor nativo.
    const escolhaPopup = page.getByRole('dialog', { name: 'Transmissão a partir de automação' })
    await escolhaPopup.getByRole('combobox', { name: 'Buscar automação' }).fill(name)
    await escolhaPopup.getByRole('option', { name: new RegExp(name) }).click()
    await escolher(page, 'Conexão de saída', `Bot de transmissões ${t}`)
    await expect(page.getByRole('region', { name: 'Prévia da automação' })).toContainText(text)
    await capture('seletor')
    await repintura('escolher-automacao')
    await page.getByRole('button', { name: 'Usar esta automação' }).click()
    await expect(page).toHaveURL(/\/broadcasts\/[^/]+$/)
    await expect(page.getByLabel('Nome da transmissão')).toHaveValue(name)
    expect(await page.locator('select').count(), 'nenhum seletor nativo no editor').toBe(0)
    await adicionarCondicao(page, 'Segmento salvo')
    await escolher(page, 'Segmento salvo', `Comunidade ${t}`)
    await expect(page.getByRole('status').filter({ hasText: 'receberá esta transmissão' })).toContainText('1 contato receberá esta transmissão')
    await acaoDoTopo(page, 'Prévia')
    await escolher(page, 'Contato de teste', 'Pessoa 3')
    await page.getByRole('button', { name: 'Enviar teste', exact: true }).click()
    await expect(page.getByText('Teste enviado.')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect.poll(() => fake.enviadas().filter(m => m.text === text).map(m => m.chat_id), { timeout: 30_000 }).toEqual(['5501003'])
    broadcast = consulta<{ id: string }>(`SELECT id FROM broadcasts WHERE workspace_id='${WORKSPACE}' AND name='${name}'`)[0].id
    expect(await api(`/api/broadcasts/${broadcast}`)).toMatchObject({ status: 'draft', metrics: { sent: 0, clicked: 0 } })
    sql([`UPDATE automations SET draft_graph='{"nodes":[],"edges":[]}' WHERE id='${automation}'`])
    await capture('editor')
    await repintura('editor')
    await acaoDoTopo(page, 'Enviar agora')
    await page.getByRole('button', { name: 'Confirmar envio', exact: true }).click()
    await expect(page).toHaveURL(/\/broadcasts$/)
    await expect.poll(() => fake.enviadas().filter(m => m.text === text).map(m => m.chat_id).sort(), { timeout: 40_000 }).toEqual(['5501001', '5501003'])
    const sent = fake.chamadas.find(c => c.metodo === 'sendMessage' && String(c.corpo.chat_id) === '5501001')!
    const callback = (sent.corpo.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0][0].callback_data
    const hook = fake.webhook()!
    for (const n of [1, 2]) {
      const response = await fetch(`${ENGINE}/api/hooks/${connection}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token }, body: JSON.stringify({ update_id: Date.now() + n, callback_query: { id: `${t}-${n}`, from: { id: 5501001, first_name: 'Pessoa 1' }, message: { message_id: 7000, chat: { id: 5501001, type: 'private' } }, data: callback } }) })
      expect(response.ok).toBeTruthy()
    }
    await expect.poll(() => fake.enviadas().filter(m => m.text === `Detalhes ${t}`).map(m => m.chat_id), { timeout: 30_000 }).toEqual(['5501001'])
    const links = (sent.corpo.reply_markup as { inline_keyboard: { url?: string }[][] }).inline_keyboard.flat()
    const tracked = links.find(button => button.url)?.url
    expect(tracked).toMatch(new RegExp(`^${ENGINE}/api/broadcast-public/click/[a-f0-9]{32}$`))
    // Não segue o redirecionamento para fora: só o motor local recebe a requisição.
    for (const attempt of [1, 2]) {
      const response = await fetch(tracked!, { redirect: 'manual' })
      expect(response.status, `clique de link ${attempt}`).toBe(302)
      expect(response.headers.get('location')).toBe('https://example.test/comunidade')
    }
    await expect.poll(() => api(`/api/broadcasts/${broadcast}`), { timeout: 30_000 }).toMatchObject({ status: 'sent', metrics: { sent: 1, clicked: 1, ctr: 1 } })
    await page.reload()
    await page.getByRole('button', { name: `Ver relatório de ${name}`, exact: true }).click()
    await page.mouse.move(0, 0)
    await expect(page.getByText('Teste enviado.', { exact: true })).toBeHidden()
    await expect(page.getByText('Envio colocado na fila.', { exact: true })).toBeHidden()
    // Lateral como a do original: quatro cartões e Público, Enviada em e Fuso; o resto dos números mora no nó do mapa.
    const lateral = page.getByRole('complementary', { name: 'Principais métricas' })
    for (const rotulo of ['Envios', 'Contatos únicos', 'E-mails', 'Telefones']) await expect(lateral.getByText(rotulo, { exact: true })).toBeVisible()
    for (const secao of ['Público', 'Enviada em', 'Fuso horário']) await expect(lateral.getByRole('region', { name: secao, exact: true })).toBeVisible()
    await expect(lateral.getByRole('progressbar')).toHaveCount(0)
    await expect(lateral.getByRole('button', { name: 'Ver por mensagem', exact: true })).toHaveCount(0)
    await expect(lateral.getByRole('region', { name: 'CTR', exact: true })).toHaveCount(0)
    const numeros = page.getByRole('application', { name: 'Mapa do fluxo enviado' }).getByRole('group', { name: 'Métricas da mensagem' })
    await expect(numeros).toHaveCount(2)
    await expect(numeros.nth(0)).toContainText('100%')
    // As funções que saíram da lateral moram no menu ⋮ do topo.
    await page.getByRole('button', { name: 'Mais ações', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Consultar destinatários', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Atualizar relatório', exact: true })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Ver por mensagem', exact: true }).click()
    const porMensagem = page.getByRole('dialog').getByRole('region', { name: 'Resultados por mensagem', exact: true })
    await expect(porMensagem.getByRole('listitem')).toHaveCount(2)
    await expect(porMensagem.getByRole('listitem').nth(0)).toContainText(text)
    await expect(porMensagem.getByRole('listitem').nth(0)).toContainText('Cliques únicos')
    await expect(porMensagem.getByRole('listitem').nth(1)).toContainText(`Detalhes ${t}`)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Mais ações', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Consultar destinatários', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('list', { name: 'Destinatários' }).getByRole('listitem')).not.toHaveCount(0)
    await page.keyboard.press('Escape')
    await capture('relatorio')
    await repintura('relatorio')
    await expect(page).toHaveURL(/\/broadcasts\/[^/]+\/report$/)
    await page.getByRole('navigation', { name: 'Você está em' }).getByRole('link', { name: 'Mensagem em massa', exact: true }).click()
    // O relatório também tem ⋮ no topo: espera a lista abrir antes de procurar a ação.
    await expect(page).toHaveURL(/\/broadcasts(\?.*)?$/)
    await expect(page.getByRole('heading', { name: 'Mensagem em massa', level: 1 })).toBeVisible()
    await acaoDoTopo(page, 'Nova transmissão')
    await page.getByLabel('Nome da transmissão').fill(`${name} agendada`)
    await escolher(page, 'Canal conectado', `Bot de transmissões ${t}`)
    await (await textoDoPasso(page)).fill('Convite agendado de teste.')
    await acaoDoTopo(page, 'Agendar')
    await page.getByLabel('Data e horário no fuso escolhido').fill('2099-10-24T12:00')
    await page.getByRole('button', { name: 'Salvar agendamento', exact: true }).click()
    await expect(page.getByText('Agendamento salvo.', { exact: true })).toBeVisible()
    await page.mouse.move(0, 0)
    await expect(page.getByText('Agendamento salvo.', { exact: true })).toBeHidden()
    // Estrutura da lista: seções por papel e nome, tabela com menu ⋮, data sem o nome técnico do fuso.
    for (const titulo of ['Agendado', 'Rascunhos', 'Histórico']) await expect(page.getByRole('heading', { name: titulo, exact: true })).toBeVisible()
    const agendado = page.getByRole('region', { name: 'Agendado', exact: true })
    if (info.project.name === 'desktop') await expect(agendado.getByRole('columnheader', { name: 'Iniciar', exact: true })).toBeVisible()
    const linha = agendado.getByRole('row').filter({ hasText: `${name} agendada` })
    await expect(linha).toHaveCount(1)
    await expect(linha.getByRole('button', { name: `Mais ações de ${name} agendada`, exact: true })).toBeVisible()
    await expect(linha).not.toContainText(/America\/|Sao_Paulo|UTC|GMT/)
    await expect(linha).toContainText(/\b2099\b/)
    await capture('lista')
    await page.getByRole('button', { name: `Editar ${name} agendada`, exact: true }).click()
    await acaoDoTopo(page, 'Prévia')
    await escolher(page, 'Contato de teste', 'Pessoa 3')
    const tested = page.waitForResponse(response => response.url().endsWith('/test') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Enviar teste', exact: true }).click()
    expect((await tested).ok()).toBeTruthy()
    await expect(page.getByText('Teste enviado.')).toBeVisible()
    expect(consulta<{status:string}>(`SELECT status FROM broadcasts WHERE name='${name} agendada'`)).toEqual([{status:'scheduled'}])
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: 'Você está em' }).getByRole('link', { name: 'Mensagem em massa', exact: true }).click()
    await page.mouse.move(0, 0)
    await expect(page.getByText('Teste enviado.', { exact: true })).toBeHidden()
    await page.getByRole('button', { name: `Mais ações de ${name} agendada`, exact: true }).click()
    await capture('agendamento')
    await page.getByRole('menuitem', { name: 'Cancelar agendamento' }).click()
    await expect(page.getByText('Agendamento cancelado.')).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: `Ver relatório de ${name} agendada` })).toBeVisible()
    expect(consulta<{ status: string }>(`SELECT status FROM broadcasts WHERE name='${name} agendada'`)).toEqual([{ status: 'cancelled' }])
  } finally {
    const copies = consulta<{ automation_id: string }>(`SELECT automation_id FROM broadcasts WHERE workspace_id='${WORKSPACE}' AND name IN ('${q(name)}','${q(name)} agendada') AND automation_id IS NOT NULL`)
    try { sql([
      `DELETE FROM broadcasts WHERE workspace_id='${WORKSPACE}' AND name IN ('${q(name)}','${q(name)} agendada')`,
      `DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id LIKE 'e2e-bc-${t}-%'`,
      `DELETE FROM segments WHERE id='${q(segment)}'`, `DELETE FROM tags WHERE id='${tag}'`,
      `DELETE FROM automations WHERE id='${automation}' OR id IN (${copies.map(row => `'${q(row.automation_id)}'`).join(',') || "''"})`,
      `DELETE FROM inbound_events WHERE channel_id='${q(connection)}'`, `DELETE FROM channels WHERE id='${q(connection)}'`,
    ]) } finally { await fake.fechar() }
  }
  async function repintura(tela: string, paginaInteira = false) {
    await page.mouse.move(0, 0)
    await page.screenshot({ animations: 'disabled', scale: 'css', fullPage: paginaInteira, path: caminhoPrint(`clone-screens/repintura/08-transmissoes-${tela}-${info.project.name}.png`) })
  }
  async function capture(screen: string, scrollTop = true) {
    if (!process.env.CAPTURE_TICKET_32) return
    const dir = pastaPrints("clone-screens"); mkdirSync(dir, { recursive: true })
    if (scrollTop && await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('heading').first().scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ animations: 'disabled', scale: 'css', path: `${dir}/32-${screen}-${info.project.name}.png` })
  }
})


test('envia prévia de modelo aprovado em transmissão nova sem texto livre', async ({ page }) => {
  const tag = novoTag(), id = `e2e-bc-modelo-${tag}`, name = `Prévia aprovada ${tag}`
  const catalog = await api<{development:{providerApiBase:string}}>('/api/connections/catalog')
  const base = catalog.development.providerApiBase
  expect(new URL(base).hostname).toBe('127.0.0.1')
  const vars = readFileSync(resolve(import.meta.dirname, '../../engine/.dev.vars'), 'utf8')
  const version = vars.match(/^CONNECTIONS_KEK_ACTIVE=["']?(\d+)/m)![1]
  const key = vars.match(new RegExp(`^CONNECTIONS_KEK_V${version}=["']?([^\\r\\n"']+)`, 'm'))![1]
  const sealed = await encryptCredentials({CONNECTIONS_KEK_ACTIVE:version,[`CONNECTIONS_KEK_V${version}`]:key},
    {workspaceId:WORKSPACE,connectionId:id},{accessToken:'TESTONLY',phoneNumberId:'123',appSecret:'TESTONLY'})
  const calls: Record<string,unknown>[] = []
  const server = createServer((req,res) => {
    const chunks:Buffer[]=[]
    req.on('data',chunk=>chunks.push(chunk))
    req.on('end',()=>{
      res.setHeader('content-type','application/json');res.setHeader('connection','close')
      if (!req.url?.endsWith('/123/messages')) {res.statusCode=404;return res.end('{}')}
      calls.push(JSON.parse(Buffer.concat(chunks).toString()))
      res.end(JSON.stringify({messaging_product:'whatsapp',messages:[{id:`fake-${calls.length}`}]}))
    })
  })
  await new Promise<void>((ok,fail)=>{server.once('error',fail);server.listen(Number(new URL(base).port),'127.0.0.1',ok)})
  try {
    sql([
      `INSERT INTO channels(id,workspace_id,type,provider,external_id,status,display_name,settings,credentials_ciphertext,credentials_iv,credentials_key_version) VALUES ('${id}','${WORKSPACE}','whatsapp','meta_whatsapp_cloud','${id}-ext','connected','Conexão modelo ${tag}','${q(JSON.stringify({apiBase:base}))}','${sealed.ciphertext}','${sealed.iv}',${sealed.keyVersion})`,
      `INSERT INTO contacts(id,workspace_id,first_name) VALUES ('${id}','${WORKSPACE}','Nara ${tag}')`,
      `INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in,identity_kind) VALUES ('${id}-cc','${WORKSPACE}','${id}','${id}','BR.testonly',1,'bsuid')`,
      `INSERT INTO message_templates(id,workspace_id,channel_id,group_id,name_human,language_code,body,status) VALUES ('${id}','${WORKSPACE}','${id}','${id}','convite_${tag}','pt_BR','Olá {{1}}, confira seu convite.','approved')`,
    ])
    await page.goto(`/${WORKSPACE}/broadcasts`)
    await acaoDoTopo(page,'Nova transmissão')
    await page.getByLabel('Nome da transmissão').fill(name)
    await escolher(page,'Canal conectado',`Conexão modelo ${tag}`)
    await escolher(page,'Tipo da transmissão','Fora da janela / promocional') // WhatsApp oficial: o tipo define o conteúdo (promocional = modelo aprovado)
    await escolher(page,'Modelo do canal',`convite_${tag} · pt_BR`)
    await page.getByLabel('Valor de 1',{exact:true}).fill('Nara')
    await acaoDoTopo(page,'Prévia')
    await page.getByLabel('Buscar contato de teste').fill(tag)
    await escolher(page,'Contato de teste',`Nara ${tag}`)
    await expect(page.getByRole('button',{name:'Enviar teste',exact:true})).toBeEnabled()
    await page.getByRole('button',{name:'Enviar teste',exact:true}).click()
    await expect(page.getByText('Teste enviado.')).toBeVisible()
    expect(calls).toEqual([expect.objectContaining({type:'template',template:{name:`convite_${tag}`,language:{code:'pt_BR'},components:[{type:'body',parameters:[{type:'text',text:'Nara'}]}]}})])
    // O teste de uma transmissão ainda não salva não deixa rascunho para trás.
    expect(consulta(`SELECT status,content FROM broadcasts WHERE name='${name}'`)).toEqual([])
  } finally {
    try {sql([`DELETE FROM broadcasts WHERE workspace_id='${WORKSPACE}' AND name='${name}'`,`DELETE FROM contacts WHERE id='${id}'`,`DELETE FROM channels WHERE id='${id}'`])}
    finally {await new Promise<void>(ok=>server.close(()=>ok()))}
  }
})
