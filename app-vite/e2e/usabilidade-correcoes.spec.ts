import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { WORKSPACE, caminhoPrint, novoTag, q, sql, acaoDoTopo, conexaoConectada, escolher } from './helpers'

type Caixa = { x: number; y: number; width: number; height: number }
const cruzam = (a: Caixa, b: Caixa) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const caixa = async (alvo: { boundingBox(): Promise<Caixa | null> }, nome: string) => {
  const box = await alvo.boundingBox()
  if (!box) throw new Error(`${nome} sem caixa na tela`)
  return box
}

// Teste de usabilidade, rodada de correções: nomes de palavra-chave no celular e o painel do passo dentro do mapa da transmissão.
test('palavras-chave no celular: o nome da regra quebra entre palavras, nunca no meio de uma', { tag: "@celular" }, async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'O problema é a coluna estreita do celular.')
  await page.goto(`/${WORKSPACE}/automations/keywords`)
  const nomes = page.getByRole('list', { name: 'Regras por prioridade' }).getByRole('heading', { level: 2 })
  await expect(nomes.first()).toBeVisible()
  const total = await nomes.count()
  expect(total).toBeGreaterThan(0)
  for (let n = 0; n < total; n++) {
    const quebradas = await nomes.nth(n).evaluate(el => {
      const texto = el.firstChild as Text, partidas: string[] = []
      const palavra = /\S+/g
      let achada: RegExpExecArray | null
      while ((achada = palavra.exec(texto.data))) {
        const faixa = document.createRange()
        faixa.setStart(texto, achada.index); faixa.setEnd(texto, achada.index + achada[0].length)
        // Uma palavra inteira numa linha só ocupa um retângulo; partida em duas linhas, mais de um.
        const linhas = new Set([...faixa.getClientRects()].map(r => Math.round(r.top)))
        if (linhas.size > 1) partidas.push(achada[0])
      }
      return partidas
    })
    expect(quebradas, `palavras partidas no nome da regra ${n + 1}`).toEqual([])
  }
  await page.screenshot({ path: caminhoPrint('usabilidade/palavras-chave-390.png') })
})

async function novaTransmissao(page: Page) {
  await page.goto(`/${WORKSPACE}/broadcasts`)
  await acaoDoTopo(page, 'Nova transmissão')
  await page.getByLabel('Nome da transmissão').fill(`Painel do passo ${novoTag()}`)
  await escolher(page, 'Canal conectado', /marina_assistente_pessoal_bot/)
  return page.getByRole('application', { name: 'Mapa do conteúdo da transmissão' })
}

test('transmissão: o painel do passo não cobre os seletores, a dica nem o passo escolhido, e a barra de blocos não cobre o texto', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'O mapa de fluxo é montado na tela ampla.')
  await page.setViewportSize({ width: 1440, height: 900 })
  const mapa = await novaTransmissao(page)
  const passo = mapa.getByRole('group', { name: /^Passo Mensagem/ }).first()
  await passo.getByText('Enviar mensagem', { exact: true }).click()
  const painel = page.getByRole('region', { name: 'Enviar mensagem' })
  const texto = page.getByRole('textbox', { name: 'Texto do bloco 1', exact: true })
  await texto.waitFor()
  // Espera o mapa deslizar para fora do painel (120 ms até decidir + 200 ms de animação): mede o próprio passo, que é o que se
  // mexe, até ele parar entre duas leituras com intervalo maior que a decisão (o seletor de canal é fixo e "para" antes de começar).
  let ultima = ''
  await expect.poll(async () => { const atual = JSON.stringify(await passo.boundingBox()); const parado = atual === ultima; ultima = atual; return parado }, { intervals: [250, 250, 250, 250, 250] }).toBe(true)
  const caixaPainel = await caixa(painel, 'painel')
  const canal = page.getByRole('combobox', { name: 'Canal conectado' })
  await expect(canal).toBeVisible()
  expect(cruzam(await caixa(canal, 'seletor de canal'), caixaPainel), 'o painel cobre o seletor de canal').toBe(false)
  expect(cruzam(await caixa(passo, 'passo'), caixaPainel), 'o painel cobre o passo escolhido').toBe(false)
  const dica = page.getByText(/Shift pressionado/)
  await expect(dica).toBeVisible()
  expect(cruzam(await caixa(dica, 'dica'), caixaPainel), 'o painel cobre a dica do mapa').toBe(false)
  expect(cruzam(await caixa(dica, 'dica'), await caixa(canal, 'seletor de canal')), 'a dica do mapa fica sob o seletor de canal').toBe(false)
  const tipo = page.getByRole('combobox', { name: 'Tipo de mensagem' })
  if (await tipo.count()) expect(cruzam(await caixa(dica, 'dica'), await caixa(tipo, 'seletor de tipo')), 'a dica do mapa fica sob o seletor de tipo').toBe(false)
  // A barra flutuante do passo (duplicar e apagar) também não pode ficar sobre os seletores do topo.
  const barra = page.getByRole('button', { name: 'Duplicar passo' })
  await expect(barra).toBeVisible()
  expect(cruzam(await caixa(barra, 'barra do passo'), await caixa(canal, 'seletor de canal')), 'a barra do passo cobre o seletor de canal').toBe(false)
  expect(cruzam(await caixa(barra, 'barra do passo'), caixaPainel), 'a barra do passo cai dentro do painel').toBe(false)

  // Digitando: a barra de blocos (subir, descer, remover) não pode ficar em cima do texto.
  await texto.click()
  await texto.fill('Olá, esta é a mensagem da transmissão')
  const subir = page.getByRole('button', { name: 'Subir bloco 1', exact: true }), remover = page.getByRole('button', { name: 'Remover bloco 1', exact: true })
  await expect(remover).toBeVisible()
  const area = await caixa(texto, 'caixa de texto')
  for (const [nome, botao] of [['Subir bloco 1', subir], ['Remover bloco 1', remover]] as const) {
    expect(cruzam(await caixa(botao, nome), area), `${nome} fica sobre o texto digitado`).toBe(false)
  }
  await page.screenshot({ path: caminhoPrint('usabilidade/painel-do-passo-1440.png') })
})

test('relatório da transmissão no celular: o mapa abre legível, com o texto dos passos em tamanho de leitura', { tag: "@celular" }, async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'O problema é o mapa encolhido no celular.')
  const t = novoTag(), id = `e2e-rel-${t}`, canal = await conexaoConectada('telegram')
  const flow = { nodes: [
    { id: 'm1', type: 'message', position: { x: 0, y: 0 }, config: { blocks: [{ kind: 'text', text: `Primeira mensagem ${t}` }] } },
    { id: 'm2', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [{ kind: 'text', text: `Segunda mensagem ${t}` }] } },
    { id: 'm3', type: 'message', position: { x: 720, y: 0 }, config: { blocks: [{ kind: 'text', text: `Terceira mensagem ${t}` }] } },
  ], edges: [{ from: 'm1', port: 'next', to: 'm2' }, { from: 'm2', port: 'next', to: 'm3' }] }
  const agora = Date.now()
  try {
    sql([`INSERT INTO broadcasts(id,workspace_id,name,channel_id,audience_filter,status,content,timezone,flow,first_node_id,started_at,updated_at) VALUES ('${id}','${WORKSPACE}','Relatório celular ${t}','${canal}','{"tag":"all"}','sent','x','America/Sao_Paulo','${q(JSON.stringify(flow))}','m1',${agora},${agora})`])
    await page.goto(`/${WORKSPACE}/broadcasts/${id}/report`)
    const mapa = page.getByRole('application', { name: 'Mapa do fluxo enviado' })
    const passo = mapa.getByRole('group', { name: /^Passo Mensagem: Primeira/ })
    await expect(passo).toBeVisible()
    await passo.scrollIntoViewIfNeeded()
    // O mapa do celular não encolhe o passo até virar um ponto: o tamanho na tela é pelo menos 70% do natural (largura do passo = --node-w).
    await expect.poll(async () => passo.evaluate(el => { const nodo = el.closest('.react-flow__node') as HTMLElement; return nodo.getBoundingClientRect().width / nodo.offsetWidth }), { timeout: 10_000 }).toBeGreaterThanOrEqual(0.7)
    // O 70% chega no meio da animação do enquadramento: mede com o passo parado entre duas leituras.
    let ultimaCaixa = ''
    await expect.poll(async () => { const atual = JSON.stringify(await passo.boundingBox()); const igual = atual === ultimaCaixa; ultimaCaixa = atual; return igual }, { intervals: [300], timeout: 10_000 }).toBe(true)
    const largura = page.viewportSize()!.width
    const dentro = await caixa(passo, 'primeiro passo')
    expect(dentro.x, 'o primeiro passo cabe na tela').toBeGreaterThanOrEqual(0)
    expect(dentro.x + dentro.width, 'o primeiro passo cabe na tela').toBeLessThanOrEqual(largura)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'a página ganhou rolagem lateral').toBe(true)
    await page.screenshot({ path: caminhoPrint('usabilidade/relatorio-390.png'), fullPage: true })
  } finally {
    sql([`DELETE FROM broadcasts WHERE id='${id}'`])
  }
})
