import { test, expect } from './fixtures'
import { WORKSPACE, api, consulta, q, sql, caminhoPrint, passo, valorEstavel, novoGatilho } from './helpers'
import { subirInstagramFalso } from './instagram-falso'

test('comentário usa posts da conexão, persiste opções e responde pelo provedor falso', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(150_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development).toBeTruthy()
  const fake = await subirInstagramFalso(Number(new URL(catalog.development!.providerApiBase).port), '17840001')
  let connection = '', id = ''
  try {
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'instagram', displayName: 'Estudos local', credentials: { accessToken: 'e2e-only', accountId: '17840001', appSecret: 'e2e-app-secret' } }) })).connection.id
    expect((await fake.comentar(connection, 'connection-proof', 'Conexão local')).status).toBe(200)
    await expect.poll(async () => (await api<{ status: string }>(`/api/connections/${connection}`)).status, { timeout: 30_000 }).toBe('connected')
    id = (await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: 'Material por comentário' }) })).id
    await api(`/api/automations/${id}/draft`, { method: 'PUT', body: JSON.stringify({ graph: {
      nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'message', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Seu guia está aqui.' }, { kind: 'button', id: 'link', label: 'Abrir guia', action: { type: 'url', url: 'https://example.com/guia' } }] } }], edges: [{ from: 'trigger', port: 'next', to: 'message' }],
    } }) })
    // A edição no celular está fora do escopo; a jornada edita em desktop e confere a leitura nos dois tamanhos.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await passo(page, 'Gatilho').click({ position: { x: 40, y: 16 } })
    await novoGatilho(page, 'Instagram', /Comentários na publicação ou Reel/)
    await page.getByLabel('Nome do gatilho').fill('Pedido do guia')
    await page.getByRole('combobox', { name: 'Conexão', exact: true }).click()
    await page.getByRole('option', { name: 'Estudos local', exact: true }).click()
    const created = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/automations/${id}/triggers`))
    await page.getByRole('button', { name: 'Criar gatilho', exact: true }).click()
    const response = await created
    expect(response.status()).toBe(201)
    const trigger = await response.json() as { id: string }
    await page.getByRole('button', { name: 'Escolher publicação', exact: true }).click()
    await expect(page.getByRole('option', { name: 'Todas as publicações ou Reels' })).toBeVisible()
    await expect(page.getByRole('option', { name: 'A próxima publicação' })).toBeVisible()
    await page.getByRole('option', { name: /Guia para organizar seus estudos/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Escolher', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Publicação alvo' })).toContainText('Guia para organizar seus estudos')
    await page.getByRole('textbox', { name: 'Nova palavra: Palavras que o comentário deve ter', exact: true }).fill('quero')
    await page.getByRole('textbox', { name: 'Nova palavra: Palavras que o comentário deve ter', exact: true }).press('Enter')
    await page.getByRole('button', { name: 'Adicionar resposta', exact: true }).click()
    await page.getByRole('textbox', { name: 'Resposta 1', exact: true }).fill('Confira seu privado!')
    // Login do Instagram: a Meta não libera curtir comentário; o painel esconde o interruptor e explica.
    await expect(page.getByRole('switch', { name: 'Curtir comentário' })).toHaveCount(0)
    await expect(page.getByText('Curtir o comentário não está disponível nesta conexão', { exact: false })).toBeVisible()
    // Em rascunho o gatilho não liga: o interruptor espera a publicação.
    await expect(page.getByRole('switch', { name: 'Gatilho ativo' })).toBeDisabled()
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    await expect(page.getByText('Gatilho salvo', { exact: true })).toBeVisible()
    await page.reload()
    await passo(page, 'Gatilho').click({ position: { x: 40, y: 16 } })
    await expect(page.getByRole('region', { name: 'Publicação alvo' })).toContainText('Guia para organizar seus estudos')
    await expect(passo(page, 'Gatilho').getByText('Comentário no post')).toBeVisible()
    await expect(page.getByRole('list', { name: 'Palavras que o comentário deve ter' })).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Curtir comentário' })).toHaveCount(0)
    expect(consulta<{ config: string }>(`SELECT config FROM triggers WHERE id='${q(trigger.id)}'`)[0].config).toContain('Guia para organizar seus estudos')
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Ao vivo', { exact: true })).toBeVisible()
    await api(`/api/automations/${id}/triggers/${trigger.id}`, { method: 'PATCH', body: JSON.stringify({ state: 'active' }) })
    await page.reload()
    expect((await fake.comentar(connection, 'comment-e2e-1', 'eu quero')).status).toBe(200)
    await expect.poll(() => fake.chamadas.filter(c => c.path.endsWith('/messages')).length, { timeout: 30_000 }).toBe(1)
    expect(fake.chamadas.find(c => c.path.endsWith('/messages'))?.body).toMatchObject({ recipient: { comment_id: 'comment-e2e-1' } })
    expect(fake.chamadas.find(c => c.path.endsWith('/replies'))?.body).toEqual({ message: 'Confira seu privado!' })
    expect(fake.chamadas.filter(c => c.path.endsWith('/likes'))).toHaveLength(0)
    expect((await fake.comentar(connection, 'comment-e2e-1', 'eu quero')).status).toBe(200)
    await expect.poll(() => consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs WHERE channel_id='${q(connection)}'`)[0]?.n).toBe(1)
    await passo(page, 'Gatilho').click({ position: { x: 40, y: 16 } })
    await expect(page.getByRole('region', { name: 'Publicação alvo' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Palavras que o comentário deve ter' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Palavras que o comentário não pode ter' })).toHaveCount(0)
    await expect(page.getByText('Publicada · versão 1', { exact: true })).toBeHidden()
    await page.setViewportSize(info.project.name === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 })
    if (info.project.name === 'mobile') await expect(page.getByRole('list', { name: 'Passos da automação' })).toBeVisible()
    const path = (process.env.E2E_CAPTURE_SCREENS === '1' || process.env.E2E_CAPTURE_TICKET16 === '1') ? caminhoPrint(`clone-screens/repintura/11-comentario-${info.project.name}.png`) : info.outputPath('comentario.png')
    await page.screenshot({ path, scale: 'css' })
    if (info.project.name === 'desktop') {
      // "Enquadrar tudo" com o painel ainda aberto: fechar o painel e enquadrar logo depois dependia de o mapa já ter voltado à largura cheia.
      await expect(page.getByRole('region', { name: 'Publicação alvo' })).toBeVisible()
      const zoom = () => page.locator('.react-flow__viewport').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a)
      // O mapa mede a própria largura um pouco depois de o painel abrir; o primeiro "Enquadrar tudo" pode usar a medida velha.
      // A referência é o enquadramento que se repete: clicar de novo dá o mesmo zoom.
      let antes = -1
      await expect.poll(async () => {
        await page.getByRole('button', { name: 'Enquadrar tudo' }).click()
        const atual = await valorEstavel(zoom)
        const repetiu = Math.abs(atual - antes) < 0.001
        antes = atual
        return repetiu
      }).toBe(true)
      await passo(page, 'Mensagem').click()
      await expect(page.getByText('Abrir o link não libera novas mensagens', { exact: false })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Mensagem' }).getByText('Resposta ao comentário')).toBeVisible()
      await expect(passo(page, 'Mensagem').getByText('Resposta ao comentário')).toBeVisible()
      // Escolher um passo nunca aproxima o mapa. Quando o passo ganha altura ou largura medida, o editor enquadra de novo (afasta o zoom),
      // o que acontece um pouco depois do clique, então a jornada espera o passo caber inteiro no mapa e só então lê o zoom.
      const cabe = async () => {
        const mapa = await page.locator('.react-flow').boundingBox(), caixa = await passo(page, 'Mensagem').boundingBox()
        return Boolean(mapa && caixa && caixa.x >= mapa.x && caixa.y >= mapa.y && caixa.x + caixa.width <= mapa.x + mapa.width && caixa.y + caixa.height <= mapa.y + mapa.height)
      }
      await expect.poll(cabe).toBe(true)
      expect(await valorEstavel(zoom)).toBeLessThanOrEqual(antes + 0.01)
      const messagePath = (process.env.E2E_CAPTURE_SCREENS === '1' || process.env.E2E_CAPTURE_TICKET16 === '1') ? caminhoPrint(`clone-screens/repintura/11-resposta-privada-desktop.png`) : info.outputPath('resposta-privada.png')
      await page.screenshot({ path: messagePath, scale: 'css' })
    } else {
      await expect(page.getByRole('list', { name: 'Passos da automação' })).toBeVisible()
      await expect(page.getByText('Use uma tela maior para editar', { exact: true })).toBeVisible()
    }
  } finally {
    if (id) sql([`DELETE FROM automations WHERE id='${q(id)}'`])
    if (connection) sql([`DELETE FROM contacts WHERE id IN (SELECT contact_id FROM contact_channels WHERE channel_id='${q(connection)}')`, `DELETE FROM channels WHERE id='${q(connection)}'`])
    await fake.fechar()
  }
})
