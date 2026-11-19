import { test, expect } from "./fixtures"
import { FOTO_PNG, WORKSPACE, canalE2eSql, contatoSql, limpezaSql, novoTag, sql, caminhoPrint } from "./helpers"

test.describe("Caixa de entrada", { tag: "@celular" }, () => {
  test("conversa aparece com nome e avatar, abre o histórico e registra nota interna", async ({ page }) => {
    const t = novoTag(), canal = `e2e-canal-${t}`, conv = `e2e-conv-${t}`
    const sobrenome = `Inbox${t}`
    sql([...canalE2eSql(canal), ...contatoSql({
      id: `e2e-inbox-${t}`, canal, nome: "Carla", sobrenome, foto: FOTO_PNG,
      conversa: { id: conv, mensagens: [{ id: `e2e-m1-${t}`, texto: `Oi, preciso de ajuda ${t}` }, { id: `e2e-m2-${t}`, texto: `Segunda mensagem ${t}` }] },
    })])
    try {
      await page.goto(`/${WORKSPACE}/inbox`)
      await page.getByRole("textbox", { name: /Buscar conversa/ }).fill(sobrenome)
      const item = page.getByRole("button", { name: new RegExp(`Carla ${sobrenome}, Telegram`) })
      await expect(item).toBeVisible()
      // Avatar: foto carregada na lista de conversas.
      const img = item.locator("img")
      await expect(img).toHaveCount(1)
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)

      await item.click()
      // Clicar na conversa atualiza o endereço.
      await expect(page).toHaveURL(new RegExp(`/${WORKSPACE}/inbox/${conv}$`))
      const historico = page.getByRole("log", { name: "Histórico da conversa" })
      await expect(historico.getByText(`Oi, preciso de ajuda ${t}`)).toBeVisible()
      await expect(historico.getByText(`Segunda mensagem ${t}`)).toBeVisible()

      // Nota interna: não é resposta, não sai pelo canal.
      const posts: string[] = []
      page.on("request", r => { if (r.method() === "POST" && r.url().includes("/messages")) posts.push(r.postData() ?? "") })
      await page.getByRole("button", { name: "Nota da equipe" }).click()
      await page.getByLabel("Anotação interna").fill(`Nota de teste ${t}`)
      await page.getByRole("button", { name: "Salvar nota" }).click()
      await expect(historico.getByText(`Nota de teste ${t}`)).toBeVisible()
      await expect(historico.getByText("Nota interna")).toBeVisible()
      expect(posts).toHaveLength(1)
      expect(JSON.parse(posts[0]).kind).toBe("note")

      // Continua lá depois de recarregar o endereço da conversa (veio do banco, não só da tela).
      await page.reload()
      await expect(page).toHaveURL(new RegExp(`/inbox/${conv}$`))
      await expect(historico.getByText(`Nota de teste ${t}`)).toBeVisible()

      // Endereço direto: abre a conversa sem passar pela lista.
      await page.goto(`/${WORKSPACE}/inbox/${conv}`)
      await expect(historico.getByText(`Oi, preciso de ajuda ${t}`)).toBeVisible()
      await expect(page.getByRole("button", { name: "Tentar de novo" })).toHaveCount(0)
    } finally {
      sql(limpezaSql())
    }
  })
})

test("caixa de entrada: compositor oferece só os anexos do canal, emoji e o nome do canal no botão", { tag: "@celular" }, async ({ page }) => {
  const t = novoTag(), canal = `e2e-canal-${t}`, conv = `e2e-anexo-${t}`, sobrenome = `Anexo${t}`
  sql([...canalE2eSql(canal), ...contatoSql({ id: `e2e-anexo-${t}`, canal, nome: "Rita", sobrenome, conversa: { id: conv, mensagens: [{ id: `e2e-a1-${t}`, texto: `Pode mandar a foto? ${t}` }] } })])
  try {
    await page.goto(`/${WORKSPACE}/inbox/${conv}`)
    await expect(page.getByRole("log", { name: "Histórico da conversa" }).getByText(`Pode mandar a foto? ${t}`)).toBeVisible()
    // No celular as ferramentas do compositor ficam atrás de "Mais opções".
    const maisOpcoes = page.getByRole("button", { name: "Mais opções" })
    if (await maisOpcoes.isVisible()) await maisOpcoes.click()
    // Telegram: a ficha do canal define o que aparece e o limite de cada tipo.
    await expect(page.getByLabel(/Anexar imagem \(até 5 MB\)/)).toHaveCount(1)
    await expect(page.getByLabel(/Anexar áudio/)).toHaveCount(1)
    const enviar = page.getByRole("button", { name: "Enviar pelo Telegram" })
    await expect(enviar).toBeDisabled()
    // Emoji entra no ponto do cursor.
    const caixa = page.getByLabel("Sua resposta")
    await caixa.fill("Segue ")
    await page.getByRole("button", { name: "Inserir emoji" }).click()
    await page.getByRole("button", { name: "Emoji 😊" }).click()
    await expect(caixa).toHaveValue("Segue 😊")
    // Tipo fora da ficha é recusado no navegador, sem subir nada.
    const subidas: string[] = []
    page.on("request", r => { if (r.method() === "POST" && r.url().includes("/api/media")) subidas.push(r.url()) })
    await page.getByLabel(/Anexar imagem/).setInputFiles({ name: "animacao.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") })
    await expect(page.getByText(/não aceita esse tipo de arquivo/)).toBeVisible()
    // Arquivo aceito fica anexado à resposta e pode ser removido; o botão habilita só com anexo.
    await page.getByLabel(/Anexar imagem/).setInputFiles({ name: "produto.png", mimeType: "image/png", buffer: Buffer.from(FOTO_PNG.split(",")[1], "base64") })
    await expect(page.getByText("produto.png")).toBeVisible()
    await page.getByRole("button", { name: "Remover anexo produto.png" }).click()
    await expect(page.getByText("produto.png")).toHaveCount(0)
    expect(subidas).toHaveLength(0)
  } finally {
    sql(limpezaSql())
  }
})

test('equipe: configura comportamento, reutiliza resposta e recebe menção persistente', { tag: "@celular" }, async ({ page }, info) => {
  const t = novoTag(), canal = `e2e-canal-${t}`, conv = `e2e-equipe-${t}`
  const { api, consulta, q } = await import('./helpers')
  const anterior = await api<{ pause_minutes: number; new_message_behavior: string }>('/api/inbox/settings')
  const contexto = await api<{ current_member_id: string; members: { id: string; name: string }[] }>('/api/inbox/context')
  const eu = contexto.members.find(m => m.id === contexto.current_member_id)!
  let respostaId: string | undefined
  sql([...canalE2eSql(canal), ...contatoSql({ id: `e2e-equipe-${t}`, canal, nome: 'Clara', sobrenome: `Equipe${t}`, conversa: { id: conv, mensagens: [{ id: `e2e-msg-${t}`, texto: 'Preciso de orientação' }] } }), `UPDATE conversations SET assignee_id='${q(eu.id)}' WHERE id='${conv}'`])
  try {
    await page.goto(`/${WORKSPACE}/settings/inbox`)
    await page.getByLabel('Suspender automações enquanto houver conversas').fill('7')
    await page.getByRole('radio', { name: 'A conversa só abre por ação da equipe' }).check()
    await page.getByRole('button', { name: 'Salvar comportamento' }).click()
    await expect(page.getByText('Comportamento salvo.')).toBeVisible()
    await page.reload()
    await expect(page.getByLabel('Suspender automações enquanto houver conversas')).toHaveValue('7')
    await page.getByRole('button', { name: 'Nova resposta pronta' }).click()
    await page.getByLabel('Atalho').fill(`ajuda${t}`)
    await page.getByLabel('Texto da resposta').fill(`Resposta reutilizável ${t}`)
    await page.getByRole('button', { name: 'Criar resposta salva' }).click()
    await expect(page.getByText(`/${'ajuda' + t}`, { exact: true })).toBeVisible()
    respostaId = (await api<{ id: string; shortcut: string }[]>('/api/inbox/saved-replies')).find(r => r.shortcut === `ajuda${t}`)?.id

    await page.goto(`/${WORKSPACE}/inbox`)
    if (info.project.name === 'mobile') await page.getByText('Pastas de atendimento', { exact: true }).click()
    await page.getByRole('button', { name: /Atribuídas a mim/ }).filter({ visible: true }).click()
    await page.getByRole('textbox', { name: /Buscar conversa/ }).fill(`Equipe${t}`)
    await page.getByRole('button', { name: new RegExp(`Clara Equipe${t},`) }).click()
    await page.getByLabel('Sua resposta').fill(`/ajuda${t}`)
    await page.getByRole('button', { name: `Usar /ajuda${t}` }).click()
    await expect(page.getByLabel('Sua resposta')).toBeFocused()
    await expect(page.getByLabel('Sua resposta')).toHaveValue(`Resposta reutilizável ${t}`)
    // A resposta fica no rascunho: nenhum envio externo é permitido nesta jornada.
    await page.getByRole('button', { name: 'Nota da equipe' }).click()
    await page.getByLabel('Anotação interna').fill('@')
    await page.getByRole('button', { name: `Mencionar ${eu.name}` }).click()
    await expect(page.getByLabel('Anotação interna')).toBeFocused()
    await expect(page.getByLabel('Anotação interna')).toHaveJSProperty('selectionStart', eu.name.length + 2)
    await page.getByLabel('Anotação interna').pressSequentially(` revisar ${t}`)
    await page.getByRole('button', { name: 'Salvar nota' }).click()
    await expect(page.getByRole('log').getByText(`@${eu.name}  revisar ${t}`, { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: new RegExp(`Menção: .*revisar ${t}`) })).toBeVisible()
    expect(consulta<{ n: number }>(`SELECT count(*) AS n FROM messages WHERE conversation_id='${conv}' AND json_extract(content,'$.sender')='human'`)[0].n).toBe(0)
    await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 })
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: caminhoPrint(`clone-screens/29-inbox-equipe-${info.project.name}.png`), fullPage: false, scale: "css" })
    await page.getByRole('button', { name: 'Nota da equipe' }).click()
    await page.getByLabel('Anotação interna').fill('@')
    await page.getByLabel('Anotação interna').scrollIntoViewIfNeeded()
    await page.screenshot({ path: caminhoPrint(`clone-screens/29-composer-equipe-${info.project.name}.png`), fullPage: false, scale: "css" })
    await page.getByRole('button', { name: new RegExp(`Menção: .*revisar ${t}`) }).click()
    await expect(page.getByRole('button', { name: new RegExp(`Menção: .*revisar ${t}`) })).toHaveCount(0)
    await page.goto(`/${WORKSPACE}/settings/inbox`)
    await expect(page.getByText(`/${'ajuda' + t}`, { exact: true })).toBeVisible()
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: caminhoPrint(`clone-screens/29-config-inbox-${info.project.name}.png`), fullPage: false, scale: "css" })
  } finally {
    if (respostaId) await api(`/api/inbox/saved-replies/${respostaId}`, { method: 'DELETE' })
    await api('/api/inbox/settings', { method: 'PUT', body: JSON.stringify(anterior) })
    sql(limpezaSql())
  }
})
