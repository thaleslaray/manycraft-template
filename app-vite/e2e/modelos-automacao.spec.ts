import { test, expect } from './fixtures'
import { ENGINE, WORKSPACE, api, novoTag, sql, q, caminhoPrint, escolher } from './helpers'
import { subirTelegramFalso, type TelegramFalso } from './telegram-falso'

test('galeria busca, avisa incompatibilidade e cria modelo persistente que publica e responde', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(120_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development).toBeTruthy()
  const tag = novoTag(), botId = 9_000_000 + Math.floor(Math.random() * 999_999)
  let fake: TelegramFalso | undefined, connection: string | undefined, automation: string | undefined
  const capture = async (name: string) => {
    await page.screenshot({ path: (process.env.E2E_CAPTURE_SCREENS === '1' || process.env.E2E_CAPTURE_TEMPLATES === '1')
      ? caminhoPrint(`clone-screens/20-${name}-${info.project.name}.png`)
      : info.outputPath(`${name}.png`), scale: 'css', animations: 'disabled' })
  }
  try {
    fake = await subirTelegramFalso(Number(new URL(catalog.development!.providerApiBase).port), { [`${botId}:e2e-${tag}`]: { id: botId, username: `e2e_${tag}` } })
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', displayName: `Modelos ${tag}`, credentials: { botToken: `${botId}:e2e-${tag}` } }) })).connection.id
    if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations`)
    await page.getByRole('button', { name: 'Nova automação', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Modelos', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Começar do zero' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /^Ver modelo:/ })).toHaveCount(6)
    // Estrutura do seletor: categorias à esquerda e grade à direita (desktop); tela cheia e faixa de uma linha só (celular).
    const categorias = dialog.getByRole('navigation', { name: 'Categorias de modelos' })
    const grade = dialog.getByRole('list', { name: 'Modelos' })
    await expect(categorias.getByRole('button', { name: /^Todos/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(categorias.getByRole('button')).toHaveCount(4)
    const caixaCategorias = (await categorias.boundingBox())!, caixaGrade = (await grade.boundingBox())!
    if (info.project.name === 'mobile') {
      const tela = page.viewportSize()!
      // A janela termina de abrir (animação) ocupando a tela inteira, sem margem.
      await expect.poll(async () => { const c = (await dialog.boundingBox())!; return [c.x, c.y, Math.round(c.width), Math.round(c.height)] }).toEqual([0, 0, tela.width, tela.height])
      const ys = await categorias.getByRole('button').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().top)))
      expect(new Set(ys).size).toBe(1)
      expect(caixaCategorias.y).toBeLessThan(caixaGrade.y)
    } else {
      expect(caixaCategorias.x + caixaCategorias.width).toBeLessThanOrEqual(caixaGrade.x)
    }
    await categorias.getByRole('button', { name: /^Atendimento/ }).click()
    await expect(categorias.getByRole('button', { name: /^Atendimento/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.getByRole('button', { name: /^Ver modelo:/ })).not.toHaveCount(6)
    await categorias.getByRole('button', { name: /^Todos/ }).click()
    await expect(dialog.getByRole('button', { name: /^Ver modelo:/ })).toHaveCount(6)
    await capture('galeria')
    await dialog.getByRole('textbox', { name: 'Buscar modelos' }).fill('inexistente')
    await expect(dialog.getByText('Nenhum modelo encontrado')).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Buscar modelos' }).fill('palavra')
    await dialog.getByRole('button', { name: 'Ver modelo: Link por palavra-chave', exact: true }).click()
    await escolher(page, 'Conexão do modelo', `Modelos ${tag}`, dialog)
    await expect(dialog.getByText('Aqui está o material que você pediu. Toque abaixo para abrir.')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Usar este modelo' })).toBeEnabled()
    if (info.project.name === 'mobile') {
      await capture('configuracao')
      await dialog.getByRole('button', { name: 'Usar este modelo' }).scrollIntoViewIfNeeded()
    }
    await capture('previa')
    // A mesma conexão muda sua ficha, sem trocar o nome do canal ou do provedor.
    sql([`UPDATE channels SET capabilities_override='{"buttons":{"types":[]}}' WHERE id='${q(connection)}'`])
    await dialog.getByRole('button', { name: 'Voltar aos modelos' }).click()
    await dialog.getByRole('button', { name: 'Ver modelo: Link por palavra-chave', exact: true }).click()
    await expect(dialog.getByText(/não permite botão de link/)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Usar este modelo' })).toBeDisabled()
    await capture('incompativel')
    sql([`UPDATE channels SET capabilities_override=NULL WHERE id='${q(connection)}'`])
    await dialog.getByRole('button', { name: 'Voltar aos modelos' }).click()
    await dialog.getByRole('button', { name: 'Ver modelo: Link por palavra-chave', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Usar este modelo' })).toBeEnabled()
    await dialog.getByRole('textbox', { name: 'Palavra que inicia' }).fill(`material${tag}`)
    await dialog.getByRole('textbox', { name: 'Link de destino' }).fill(`https://example.com/material-${tag}`)
    await dialog.getByRole('button', { name: 'Usar este modelo' }).click()
    await expect(page).toHaveURL(/\/automations\/[^/]+$/)
    automation = page.url().split('/').pop()!
    await page.reload()
    const draft = await api<{ automation: { status: string; draft_graph: { template: { id: string; version: number } } }; triggers: { channel_id: string }[] }>(`/api/automations/${automation}`)
    expect(draft.automation).toMatchObject({ status: 'draft', draft_graph: { template: { id: 'link-palavra', version: 1 } } })
    expect(draft.triggers[0]?.channel_id).toBe(connection)
    // Edição no celular está fora do escopo; publicar e disparar usam o desktop.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Ao vivo', { exact: true })).toBeVisible()
    const hook = fake.webhook()!
    const event = Date.now()
    const response = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token }, body: JSON.stringify({ update_id: event, message: { message_id: event, from: { id: botId + 1, first_name: 'Pessoa de teste' }, chat: { id: botId + 1, type: 'private' }, text: `material${tag}` } }) })
    expect(response.status).toBe(200)
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual(['Aqui está o material que você pediu. Toque abaixo para abrir.'])
    expect(fake.chamadas.find(c => c.metodo === 'sendMessage')?.corpo.reply_markup).toMatchObject({ inline_keyboard: [[{ text: 'Abrir material', url: `https://example.com/material-${tag}` }]] })
  } finally {
    await fake?.fechar()
    const ws = `workspace_id='${WORKSPACE}'`
    if (automation) sql([`DELETE FROM automations WHERE ${ws} AND id='${q(automation)}'`])
    if (connection) sql([
      `DELETE FROM contacts WHERE ${ws} AND id IN (SELECT contact_id FROM contact_channels WHERE ${ws} AND channel_id='${q(connection)}')`,
      `DELETE FROM inbound_events WHERE ${ws} AND channel_id='${q(connection)}'`,
      `DELETE FROM channels WHERE ${ws} AND id='${q(connection)}'`,
    ])
  }
})
