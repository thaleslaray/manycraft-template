import { test, expect } from './fixtures'
import { WORKSPACE, api, consulta, q, sql, caminhoPrint, novoGatilho as novoGatilhoDoPopup } from './helpers'
import { subirInstagramFalso } from './instagram-falso'

const capturando = process.env.E2E_CAPTURE_SCREENS === '1' || process.env.E2E_CAPTURE_TICKET17 === '1'
const imagem = (nome: string, projeto: string, fallback: string) => capturando ? caminhoPrint(`clone-screens/17-${nome}-${projeto}.png`) : fallback

test('resposta e menção em story: gatilhos persistem, só o story e a condição certos respondem, coração e atraso valem', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(240_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development).toBeTruthy()
  const fake = await subirInstagramFalso(Number(new URL(catalog.development!.providerApiBase).port), '17840001')
  let connection = ''
  const automations: string[] = []
  const privadas = () => fake.chamadas.filter(c => c.path.endsWith('/messages') && c.body.message)
  const criar = async (nome: string, texto: string) => {
    const id = (await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: nome }) })).id
    automations.push(id)
    await api(`/api/automations/${id}/draft`, { method: 'PUT', body: JSON.stringify({ graph: {
      nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'message', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [{ kind: 'text', text: texto }] } }], edges: [{ from: 'trigger', port: 'next', to: 'message' }],
    } }) })
    return id
  }
  const novoGatilho = async (id: string, tipo: string, nome: string) => {
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await page.locator('.react-flow__node-trigger').click({ position: { x: 40, y: 16 } })
    await novoGatilhoDoPopup(page, 'Instagram', tipo === 'Resposta a story' ? /Resposta ao story/ : /Menção no story/)
    await page.getByLabel('Nome do gatilho').fill(nome)
    await page.getByRole('combobox', { name: 'Conexão', exact: true }).click()
    await page.getByRole('option', { name: 'Estudos local', exact: true }).click()
    const created = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/automations/${id}/triggers`))
    await page.getByRole('button', { name: 'Criar gatilho', exact: true }).click()
    const response = await created
    expect(response.status()).toBe(201)
    return (await response.json() as { id: string }).id
  }
  const salvar = async () => {
    // Em rascunho o gatilho não liga: o interruptor espera a publicação e o gatilho nasce Inicial.
    await expect(page.getByRole('switch', { name: 'Gatilho ativo' })).toBeDisabled()
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    await expect(page.getByText('Gatilho salvo', { exact: true })).toBeVisible()
  }
  const publicar = async (automacao: string, gatilho: string) => {
    await page.getByRole('button', { name: 'Fechar painel', exact: true }).click()
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Ao vivo', { exact: true })).toBeVisible()
    await api(`/api/automations/${automacao}/triggers/${gatilho}`, { method: 'PATCH', body: JSON.stringify({ state: 'active' }) })
  }
  try {
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'instagram', displayName: 'Estudos local', credentials: { accessToken: 'e2e-only', accountId: '17840001', appSecret: 'e2e-app-secret' } }) })).connection.id
    expect((await fake.comentar(connection, 'connection-proof', 'Conexão local')).status).toBe(200)
    await expect.poll(async () => (await api<{ status: string }>(`/api/connections/${connection}`)).status, { timeout: 30_000 }).toBe('connected')
    // A edição no celular está fora do escopo: a jornada edita em desktop e confere a leitura nos dois tamanhos.
    await page.setViewportSize({ width: 1440, height: 900 })

    // Resposta a story: story específico + condição + política.
    const replyAutomation = await criar('Story com resposta', 'Obrigado por responder ao story!')
    const reply = await novoGatilho(replyAutomation, 'Resposta a story', 'Pedido de preço')
    await page.getByRole('button', { name: 'Escolher story', exact: true }).click()
    await page.getByRole('option', { name: /bastidores do lançamento/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Escolher', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Story alvo' })).toContainText('bastidores do lançamento')
    await page.getByRole('combobox', { name: 'Condição' }).click()
    await page.getByRole('option', { name: 'Contém uma destas palavras', exact: true }).click()
    const words = page.getByRole('textbox', { name: 'Nova palavra: Palavras da resposta', exact: true })
    await words.fill('preço'); await words.press('Enter')
    await page.getByRole('combobox', { name: 'Frequência' }).click()
    await page.getByRole('option', { name: 'Uma vez a cada 24 horas', exact: true }).click()
    await salvar()
    await page.reload()
    await page.locator('.react-flow__node-trigger').click({ position: { x: 40, y: 16 } })
    await expect(page.getByRole('region', { name: 'Story alvo' })).toContainText('bastidores do lançamento')
    await expect(page.getByRole('combobox', { name: 'Condição' })).toContainText('Contém uma destas palavras')
    await expect(page.getByRole('combobox', { name: 'Frequência' })).toContainText('Uma vez a cada 24 horas')
    const stored = consulta<{ post_scope: string; target_post_id: string; repeat_mode: string; status: string; config: string }>(`SELECT post_scope,target_post_id,repeat_mode,status,config FROM triggers WHERE id='${q(reply)}'`)[0]
    expect(stored).toMatchObject({ post_scope: 'specific', target_post_id: '770001', repeat_mode: 'once_per_24_hours', status: 'initial' })
    expect(stored.config).toContain('preço')
    if (info.project.name === 'desktop') await page.screenshot({ path: imagem('resposta-story', 'desktop', info.outputPath('resposta-story.png')), scale: 'css' })
    await publicar(replyAutomation, reply)
    expect(consulta<{ status: string }>(`SELECT status FROM triggers WHERE id='${q(reply)}'`)).toEqual([{ status: 'active' }])

    // Menção em story: atraso de 30 s, coração e uma vez a cada 24 h.
    const mentionAutomation = await criar('Story com menção', 'Valeu pela menção!')
    const mention = await novoGatilho(mentionAutomation, 'Menção em story', 'Menção no story')
    await page.getByRole('combobox', { name: 'Esperar antes de responder' }).click()
    await page.getByRole('option', { name: '30 segundos', exact: true }).click()
    await page.getByRole('combobox', { name: 'Frequência' }).click()
    await page.getByRole('option', { name: 'Uma vez a cada 24 horas', exact: true }).click()
    await page.getByRole('switch', { name: 'Reagir com coração à menção' }).check()
    await salvar()
    await page.reload()
    await page.locator('.react-flow__node-trigger').click({ position: { x: 40, y: 16 } })
    await expect(page.getByRole('combobox', { name: 'Esperar antes de responder' })).toContainText('30 segundos')
    await expect(page.getByRole('switch', { name: 'Reagir com coração à menção' })).toBeChecked()
    expect(consulta<{ delay_seconds: number; story_auto_like: number; repeat_mode: string }>(`SELECT delay_seconds,story_auto_like,repeat_mode FROM triggers WHERE id='${q(mention)}'`)[0])
      .toEqual({ delay_seconds: 30, story_auto_like: 1, repeat_mode: 'once_per_24_hours' })
    if (info.project.name === 'desktop') await page.screenshot({ path: imagem('mencao-story', 'desktop', info.outputPath('mencao-story.png')), scale: 'css' })
    await publicar(mentionAutomation, mention)

    // Resposta: o story errado e a frase sem a palavra não respondem; a combinação certa responde uma vez.
    expect((await fake.responderStory(connection, 'story-reply-1', 'qual o preço?', '770002')).status).toBe(200)
    expect((await fake.responderStory(connection, 'story-reply-2', 'bom dia', '770001')).status).toBe(200)
    expect((await fake.responderStory(connection, 'story-reply-3', 'Qual o PRECO?', '770001')).status).toBe(200)
    await expect.poll(() => privadas().length, { timeout: 30_000 }).toBe(1)
    expect(privadas()[0].body).toMatchObject({ recipient: { id: '190001' }, message: { text: 'Obrigado por responder ao story!' } })
    expect((await fake.responderStory(connection, 'story-reply-4', 'preço de novo', '770001')).status).toBe(200)
    expect(consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs WHERE trigger_id='${q(reply)}'`)[0].n).toBe(1)

    // Menção: coração na hora, resposta só depois do atraso, segunda menção no mesmo dia não repete.
    const antes = Date.now()
    expect((await fake.mencionarStory(connection, 'mention-1')).status).toBe(200)
    await expect.poll(() => fake.chamadas.filter(c => c.body.sender_action === 'react').length, { timeout: 30_000 }).toBe(1)
    expect(fake.chamadas.find(c => c.body.sender_action === 'react')?.body).toEqual({ recipient: { id: '190001' }, sender_action: 'react', payload: { message_id: 'mention-1', reaction: 'love' } })
    expect(privadas()).toHaveLength(1)
    await expect.poll(() => privadas().length, { timeout: 90_000 }).toBe(2)
    expect(Date.now() - antes).toBeGreaterThanOrEqual(28_000)
    expect(privadas()[1].body).toMatchObject({ message: { text: 'Valeu pela menção!' } })
    expect((await fake.mencionarStory(connection, 'mention-2')).status).toBe(200)
    await expect.poll(() => consulta<{ n: number }>(`SELECT count(*) n FROM inbound_events WHERE channel_id='${q(connection)}' AND id LIKE '%mention-2%'`)[0].n).toBe(1)
    expect(consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs WHERE trigger_id='${q(mention)}'`)[0].n).toBe(1)

    // Leitura nos dois tamanhos do celular (no desktop a captura do painel já foi feita acima).
    if (info.project.name === 'mobile') for (const [nome, auto] of [['resposta-story', replyAutomation], ['mencao-story', mentionAutomation]] as const) {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`/${WORKSPACE}/automations/${auto}`)
      await expect(page.getByRole('list', { name: 'Passos da automação' })).toBeVisible()
      await expect(page.getByText('Use uma tela maior para editar', { exact: true })).toBeVisible()
      await page.screenshot({ path: imagem(nome, 'mobile', info.outputPath(`${nome}.png`)), scale: 'css' })
    }
  } finally {
    for (const id of automations) sql([`DELETE FROM automations WHERE id='${q(id)}'`])
    if (connection) sql([`DELETE FROM contacts WHERE id IN (SELECT contact_id FROM contact_channels WHERE channel_id='${q(connection)}')`, `DELETE FROM channels WHERE id='${q(connection)}'`])
    await fake.fechar()
  }
})
