import { test, expect } from './fixtures'
import { WORKSPACE, api, consulta, novoTag, q, sql, caminhoPrint, escolher } from './helpers'

// Em celular emulado, a linha perto da borda de baixo faz o menu abrir sob o dedo (a rolagem trava e o layout desloca) e o
// toque seleciona um item. Abrir pelo teclado cobre o mesmo menu sem depender desse deslocamento.
async function abrirAcoes(button: import('@playwright/test').Locator) {
  if ((button.page().viewportSize()?.width ?? 1440) >= 768) await button.click()
  else { await button.focus(); await button.press('Enter') }
  await expect(button.page().getByRole('menu')).toBeVisible()
}

async function escolherAcao(page: import('@playwright/test').Page, name: string) {
  const item = page.getByRole('menuitem', { name, exact: true })
  await item.focus()
  await item.press('Enter')
}

// Filtros da lista usam o Select do sistema (combobox que abre uma lista de opções).
async function escolherFiltro(page: import('@playwright/test').Page, filtro: string, opcao: string) {
  await page.getByRole('combobox', { name: filtro, exact: true }).click()
  await page.getByRole('option', { name: opcao, exact: true }).click()
}

test('organizar pastas, duplicar, enviar à lixeira e restaurar persiste no motor', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(120_000)
  const tag = novoTag(), name = `Atendimento ${tag}`, folderName = `Campanhas ${tag}`, childName = `Oficinas ${tag}`
  const ids: string[] = []
  const screenshot = (screen: string) => process.env.E2E_CAPTURE_SCREENS === '1'
    ? caminhoPrint(`clone-screens/10-${screen}-${info.project.name}.png`)
    : info.outputPath(`${screen}.png`)
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 })
  try {
    const created = await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name }) })
    ids.push(created.id)
    await page.goto(`/${WORKSPACE}/automations`)
    await page.getByRole('button', { name: 'Nova pasta', exact: true }).click()
    await page.getByRole('textbox', { name: 'Nome da pasta', exact: true }).fill(folderName)
    await page.screenshot({ path: screenshot('nova-pasta'), scale: 'css', animations: 'disabled' })
    await page.getByRole('button', { name: 'Salvar pasta', exact: true }).click()
    await page.getByRole('button', { name: `Abrir pasta ${folderName}`, exact: true }).click()
    await page.getByRole('button', { name: 'Nova pasta', exact: true }).click()
    await page.getByRole('textbox', { name: 'Nome da pasta', exact: true }).fill(childName)
    await page.getByRole('button', { name: 'Salvar pasta', exact: true }).click()
    await page.reload()
    await expect(page.getByRole('button', { name: `Abrir pasta ${childName}`, exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Minhas automações', exact: true }).click()
    const row = (label: string) => page.getByRole('listitem').filter({ has: page.getByRole('link', { name: label, exact: true }) })
    await abrirAcoes(row(name).getByRole('button', { name: `Mais ações de ${name}`, exact: true }))
    await escolherAcao(page, 'Mover')
    await escolher(page, 'Pasta de destino', `${folderName} / ${childName}`)
    await page.screenshot({ path: screenshot('mover'), scale: 'css', animations: 'disabled' })
    await page.getByRole('button', { name: 'Mover automação', exact: true }).click()
    await expect.poll(() => consulta<{ name: string }>(`SELECT f.name FROM automations a JOIN folders f ON f.id=a.folder_id WHERE a.id='${q(created.id)}'`)[0]?.name).toBe(childName)
    // Na raiz a lista traz só as automações soltas; a busca varre todas as pastas.
    await page.getByRole('textbox', { name: 'Buscar automação', exact: true }).fill(name)
    await abrirAcoes(row(name).getByRole('button', { name: `Mais ações de ${name}`, exact: true }))
    await escolherAcao(page, 'Duplicar')
    const copyName = `${name} (cópia)`
    await expect(row(copyName)).toBeVisible()
    ids.push(...consulta<{ id: string }>(`SELECT id FROM automations WHERE workspace_id='${WORKSPACE}' AND name='${q(copyName)}'`).map(a => a.id))
    await abrirAcoes(row(copyName).getByRole('button', { name: `Mais ações de ${copyName}`, exact: true }))
    await escolherAcao(page, 'Renomear')
    await page.getByRole('textbox', { name: 'Nome da automação', exact: true }).fill(`${name} revisado`)
    await page.getByRole('button', { name: 'Salvar nome', exact: true }).click()
    await page.reload()
    await expect(row(`${name} revisado`)).toBeVisible()
    await page.getByRole('button', { name: `Abrir pasta ${folderName}`, exact: true }).click()
    await expect(page.getByRole('button', { name: `Abrir pasta ${childName}`, exact: true })).toBeVisible()
    await page.screenshot({ path: screenshot('pastas'), scale: 'css', animations: 'disabled' })
    await page.getByRole('button', { name: `Abrir pasta ${childName}`, exact: true }).click()
    await abrirAcoes(row(name).getByRole('button', { name: `Mais ações de ${name}`, exact: true }))
    await escolherAcao(page, 'Enviar à lixeira')
    await page.getByRole('button', { name: 'Confirmar envio à lixeira', exact: true }).click()
    await expect(row(name)).toHaveCount(0)
    await page.getByRole('button', { name: 'Lixeira', exact: true }).click()
    await page.reload()
    const trashRow = page.getByRole('listitem').filter({ hasText: name }).filter({ has: page.getByRole('button', { name: `Mais ações de ${name}`, exact: true }) })
    await expect(trashRow).toBeVisible()
    await page.screenshot({ path: screenshot('lixeira'), scale: 'css', animations: 'disabled' })
    await abrirAcoes(trashRow.getByRole('button', { name: `Mais ações de ${name}`, exact: true }))
    await escolherAcao(page, 'Restaurar')
    await expect(trashRow).toHaveCount(0)
    await page.getByRole('button', { name: 'Minhas automações', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Minhas automações', level: 2 })).toBeVisible()
    await page.getByRole('textbox', { name: 'Buscar automação', exact: true }).fill(name)
    await page.reload()
    await expect(row(name)).toBeVisible()
    expect((await api<{ automation: { deleted_at: string | null } }>(`/api/automations/${created.id}`)).automation.deleted_at).toBeNull()
    if (info.project.name === 'mobile') await page.getByRole('list', { name: 'Automações', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: screenshot('lista'), scale: 'css', animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    // A cópia pode ter sido criada antes de uma falha de interface.
    sql([
      `DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND (id IN (${ids.map(id => `'${q(id)}'`).join(',') || "''"}) OR name LIKE '%${q(tag)}%')`,
      `DELETE FROM folders WHERE workspace_id='${WORKSPACE}' AND name LIKE '%${q(tag)}%'`,
    ])
  }
})

test('carrega mais 30 por vez e filtra tipo e estado de gatilho', async ({ page }) => {
  test.setTimeout(120_000)
  const tag = novoTag(), prefix = `e2e-library-${tag}`
  try {
    sql(Array.from({ length: 34 }, (_, i) => `INSERT INTO automations(id,workspace_id,name,updated_at) VALUES ('${prefix}-${i}','${WORKSPACE}','Biblioteca ${tag} ${i}',1000)`))
    sql([`INSERT INTO triggers(id,workspace_id,automation_id,name,kind,status) VALUES ('${prefix}-trigger','${WORKSPACE}','${prefix}-0','Mensagem recebida','keyword','active')`])
    await page.goto(`/${WORKSPACE}/automations`)
    await page.getByRole('textbox', { name: 'Buscar automação' }).fill(`Biblioteca ${tag}`)
    const rows = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: new RegExp(`Biblioteca ${tag}`) }) })
    await expect(rows).toHaveCount(30)
    // No celular emulado a viewport visual (844) é menor que a de layout: o toque perto da borda cai numa linha. Teclado é o mesmo botão.
    const maisBotao = page.getByRole('button', { name: 'Carregar mais', exact: true })
    await maisBotao.focus()
    await maisBotao.press('Enter')
    await expect(rows).toHaveCount(34)
    await expect(page.getByRole('button', { name: 'Carregar mais', exact: true })).toHaveCount(0)
    await escolherFiltro(page, 'Tipo de gatilho', 'Palavra-chave')
    await expect(rows).toHaveCount(1)
    await escolherFiltro(page, 'Estado do gatilho', 'Desligado')
    await expect(rows).toHaveCount(0)
    await escolherFiltro(page, 'Estado do gatilho', 'Ativo')
    await expect(rows).toHaveCount(1)
    await page.reload()
    await expect(rows).toHaveCount(1)
  } finally {
    sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id LIKE '${prefix}-%'`])
  }
})

test('renomeia e move pastas, arrasta uma automação e exclui da lixeira de vez', { tag: "@celular" }, async ({ page, isMobile }) => {
  test.setTimeout(120_000)
  const tag = novoTag(), first = `Origem ${tag}`, second = `Destino ${tag}`, renamed = `Arquivo ${tag}`, name = `Fluxo ${tag}`
  let id: string | undefined
  try {
    const a = await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name }) })
    id = a.id
    await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: first }) })
    await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: second }) })
    await page.goto(`/${WORKSPACE}/automations`)
    await page.getByRole('button', { name: `Ações da pasta ${first}`, exact: true }).click()
    await escolherAcao(page, 'Renomear')
    await page.getByRole('textbox', { name: 'Nome da pasta', exact: true }).fill(renamed)
    await page.getByRole('button', { name: 'Salvar pasta', exact: true }).click()
    await page.getByRole('button', { name: `Ações da pasta ${renamed}`, exact: true }).click()
    await escolherAcao(page, 'Mover')
    await escolher(page, 'Pasta de destino', second)
    await page.getByRole('button', { name: 'Mover pasta', exact: true }).click()
    await page.reload()
    await expect(page.getByRole('button', { name: `Abrir pasta ${renamed}`, exact: true })).toHaveCount(0)
    const row = page.getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) })
    if (!isMobile) {
      await page.getByRole('link', { name, exact: true }).dragTo(page.getByRole('button', { name: `Abrir pasta ${second}`, exact: true }))
      await expect.poll(() => consulta<{ name: string }>(`SELECT f.name FROM automations a JOIN folders f ON f.id=a.folder_id WHERE a.id='${q(id!)}'`)[0]?.name).toBe(second)
    }
    await page.getByRole('button', { name: `Abrir pasta ${second}`, exact: true }).click()
    await expect(page.getByRole('button', { name: `Abrir pasta ${renamed}`, exact: true })).toBeVisible()
    if (!isMobile) {
      await page.getByRole('button', { name: `Abrir pasta ${renamed}`, exact: true }).dragTo(page.getByRole('button', { name: 'Minhas automações', exact: true }))
      await expect.poll(() => consulta<{ parent_id: string | null }>(`SELECT parent_id FROM folders WHERE workspace_id='${WORKSPACE}' AND name='${q(renamed)}'`)[0]?.parent_id).toBeNull()
    }
    await page.getByRole('button', { name: 'Minhas automações', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Minhas automações', level: 2 })).toBeVisible()
    await page.getByRole('textbox', { name: 'Buscar automação', exact: true }).fill(name)
    await abrirAcoes(row.getByRole('button', { name: `Mais ações de ${name}`, exact: true }))
    await escolherAcao(page, 'Enviar à lixeira')
    await page.getByRole('button', { name: 'Confirmar envio à lixeira', exact: true }).click()
    await page.getByRole('button', { name: 'Lixeira', exact: true }).click()
    await abrirAcoes(page.getByRole('listitem').filter({ has: page.getByRole('button', { name: `Mais ações de ${name}`, exact: true }) }).getByRole('button', { name: `Mais ações de ${name}`, exact: true }))
    await escolherAcao(page, 'Excluir definitivamente')
    await page.getByRole('button', { name: 'Confirmar exclusão definitiva', exact: true }).click()
    await expect.poll(() => consulta(`SELECT id FROM automations WHERE id='${q(id!)}'`).length).toBe(0)
  } finally {
    sql([
      `DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(id ?? '')}'`,
      `DELETE FROM folders WHERE workspace_id='${WORKSPACE}' AND name LIKE '%${q(tag)}%'`,
    ])
  }
})

test('"Sem pasta" lista só as soltas e "Ver todas as automações" traz também as de pasta', async ({ page }) => {
  const tag = novoTag(), pasta = `Pasta ${tag}`, solta = `Solta ${tag}`, dentro = `Dentro ${tag}`, ids: string[] = []
  try {
    const folder = await api<{ id: string }>('/api/folders', { method: 'POST', body: JSON.stringify({ name: pasta, parent_id: null }) })
    ids.push((await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: solta }) })).id)
    ids.push((await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: dentro, folder_id: folder.id }) })).id)
    await page.goto(`/${WORKSPACE}/automations`)
    await expect(page.getByRole('link', { name: solta, exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: dentro, exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Sem pasta', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Sem pasta', level: 2 })).toBeVisible()
    await expect(page.getByRole('link', { name: solta, exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: dentro, exact: true })).toHaveCount(0)
    // Uma busca sem resultado oferece "Ver todas as automações", que lista as de qualquer pasta.
    await page.getByRole('textbox', { name: 'Buscar automação', exact: true }).fill(`inexistente ${tag}`)
    await page.getByRole('button', { name: 'Ver todas as automações', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Todas as automações', level: 2 })).toBeVisible()
    await expect(page.getByRole('link', { name: dentro, exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: solta, exact: true })).toBeVisible()
  } finally {
    sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id IN (${ids.map(i => `'${q(i)}'`).join(',') || "''"})`, `DELETE FROM folders WHERE workspace_id='${WORKSPACE}' AND name='${q(pasta)}'`])
  }
})
