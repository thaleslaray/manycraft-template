import { test, expect } from './fixtures'
import { api, escolher, canalE2eSql, contatoSql, consulta, limpezaSql, novoTag, sql, WORKSPACE, caminhoPrint } from './helpers'

test('regra publicada inscreve por tag individual, preserva rascunho e ignora lote', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(150_000)
  const t = novoTag(), tag = `e2e-lead-${t}`, seq = `e2e-rule-seq-${t}`, contact = `e2e-rule-person-${t}`, bulk = `e2e-rule-bulk-${t}`, channel = `e2e-rule-channel-${t}`
  const name = `Acompanhar lead ${t}`, sequenceName = `Conteúdo para leads ${t}`, tagName = `Lead ${t}`
  let rule: string | undefined, copy: string | undefined
  const capture = async (screen: string) => {
    if (process.env.E2E_CAPTURE_SCREENS === '1') await page.screenshot({ path: caminhoPrint(`clone-screens/repintura/04-regras-${screen}-${info.project.name}.png`), scale: 'css', animations: 'disabled' })
  }
  sql([...canalE2eSql(channel), ...[contact, bulk].flatMap((id, i) => contatoSql({ id, canal: channel, nome: `Lead ${i + 1}`, sobrenome: t })),
    `INSERT INTO tags(id,workspace_id,name) VALUES ('${tag}','${WORKSPACE}','${tagName}')`,
    `INSERT INTO sequences(id,workspace_id,name) VALUES ('${seq}','${WORKSPACE}','${sequenceName}')`,
    `INSERT INTO sequence_steps(id,workspace_id,sequence_id,position,delay_seconds,status) VALUES ('e2e-rule-step-${t}','${WORKSPACE}','${seq}',0,3600,'draft')`])
  try {
    await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/rules`)
    await expect(page.getByRole('heading', { name: 'Regras', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Criar regra', exact: true }).click()
    await page.getByRole('textbox', { name: 'Nome da regra' }).fill(name)
    await escolher(page, 'Gatilho', 'Tag aplicada')
    await escolher(page, 'Tag do evento', tagName)
    await page.getByRole('button', { name: 'Adicionar ação', exact: true }).click()
    await escolher(page, 'Tipo da ação 1', 'Inscrever em sequência')
    await escolher(page, 'Sequência da ação 1', sequenceName)
    const gatilho = await page.getByRole('heading', { name: 'Quando acontecer', exact: true }).boundingBox()
    const acoes = await page.getByRole('heading', { name: 'Então executar', exact: true }).boundingBox()
    expect(acoes!.y).toBeGreaterThan(gatilho!.y + 40)
    expect(Math.abs(acoes!.x - gatilho!.x)).toBeLessThan(4)
    const linha = page.getByRole('group', { name: 'Ação 1' })
    await expect(linha).toContainText('Inscrever em sequência')
    await expect(linha).toContainText(sequenceName)
    await expect(page.locator('fieldset legend')).toHaveCount(0)
    await capture('editor')
    await page.getByRole('button', { name: 'Publicar regra', exact: true }).scrollIntoViewIfNeeded()
    await capture('editor-final')
    await page.getByRole('button', { name: 'Publicar regra', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Regras', exact: true })).toBeVisible()
    const rules = await api<{ id: string; name: string }[]>('/api/rules')
    rule = rules.find(r => r.name === name)!.id
    await page.reload()
    const row = page.getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) })
    await expect(row).toContainText('Ativa')
    await page.getByRole('button', { name, exact: true }).click()
    await escolher(page, 'Frequência', 'Uma vez por contato')
    await escolher(page, 'Tag do evento', 'Qualquer tag')
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Regras', exact: true })).toBeVisible()
    const saved = await api<{ draft: { frequency: string; event_filter: object }; published: { frequency: string } }>(`/api/rules/${rule}`)
    expect(saved.draft.frequency).toBe('once')
    expect(saved.draft.event_filter).toEqual({})
    // Regra ativa editada é republicada na hora (need_activate): a versão no ar não fica velha.
    expect(saved.published.frequency).toBe('once')
    await page.reload()
    await expect(row).toContainText('Ativa')
    await expect(row).not.toContainText('Alterações em rascunho')
    await api('/api/contacts/bulk-tag', { method: 'POST', body: JSON.stringify({ ids: [bulk], tag_id: tag, op: 'add' }) })
    expect(consulta(`SELECT * FROM sequence_subscriptions WHERE contact_id='${bulk}' AND sequence_id='${seq}'`)).toHaveLength(0)
    await page.goto(`/${WORKSPACE}/contacts?contact=${contact}`)
    await page.getByRole('button', { name: 'Adicionar tag', exact: true }).click()
    await page.getByRole('combobox', { name: 'Buscar ou criar tag' }).fill(tagName)
    await page.getByRole('option', { name: tagName, exact: true }).click()
    const section = page.getByRole('region', { name: 'Sequências do contato' })
    await expect(section).toContainText(sequenceName)
    await page.reload()
    await expect(section).toContainText(sequenceName)
    await section.scrollIntoViewIfNeeded()
    await capture('perfil')
    expect(consulta(`SELECT * FROM sequence_subscriptions WHERE contact_id='${contact}' AND sequence_id='${seq}'`)).toHaveLength(1)
    await page.goto(`/${WORKSPACE}/automations/rules`)
    await expect(row.getByRole('cell').nth(2)).toHaveText('1')
    await expect(row.getByRole('cell').nth(3)).toHaveText('1')
    await capture('lista')
    await row.getByRole('switch').click()
    await expect(row).toContainText('Pausada')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
    await expect(row.getByRole('button', { name: `Duplicar ${name}` })).toHaveCount(0)
    await row.getByRole('button', { name: `Mais ações de ${name}`, exact: true }).click()
    await capture('lista-menu')
    await page.getByRole('menuitem', { name: 'Duplicar', exact: true }).click()
    await expect(page.getByRole('button', { name: `${name} (cópia)`, exact: true })).toBeVisible()
    const updated = await api<{ id: string; name: string; active: boolean; executions: number }[]>('/api/rules')
    const duplicated = updated.find(r => r.id !== rule && r.name === `${name} (cópia)`)!
    copy = duplicated.id
    expect(duplicated.active).toBe(false)
    expect(duplicated.executions).toBe(0)
    await page.getByRole('row').filter({ has: page.getByRole('button', { name: `${name} (cópia)`, exact: true }) }).getByRole('button', { name: `Mais ações de ${name} (cópia)`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Excluir', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await capture('excluir')
    await page.getByRole('dialog').getByRole('button', { name: 'Excluir regra', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: `${name} (cópia)`, exact: true })).toHaveCount(0)
  } finally {
    for (const created of await api<{ id: string; name: string }[]>('/api/rules')) {
      if (created.id === rule || created.id === copy || created.name === name || created.name === `${name} (cópia)`) await api(`/api/rules/${created.id}`, { method: 'DELETE' })
    }
    sql([`DELETE FROM sequences WHERE id='${seq}'`, `DELETE FROM tags WHERE id='${tag}'`, ...limpezaSql()])
  }
})

test('editor exige gatilho, ação e campo de data e mantém condição em dois níveis', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(90_000)
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 })
  const t = novoTag(), tag = `e2e-rule-condition-${t}`, date = `e2e-rule-date-${t}`, name = `Aniversário ${t}`
  let rule: string | undefined
  sql([`INSERT INTO tags(id,workspace_id,name) VALUES ('${tag}','${WORKSPACE}','Cliente ${t}')`,
    `INSERT INTO custom_fields(id,workspace_id,name,type,scope) VALUES ('${date}','${WORKSPACE}','Aniversário ${t}','date','contact')`])
  try {
    await page.goto(`/${WORKSPACE}/automations/rules`)
    await page.getByRole('button', { name: 'Criar regra', exact: true }).click()
    await page.getByRole('textbox', { name: 'Nome da regra' }).fill(name)
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('gatilho')
    await escolher(page, 'Gatilho', 'Data do contato')
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('campo de data')
    await escolher(page, 'Campo de data', `Aniversário ${t}`)
    await page.getByRole('checkbox', { name: 'Repetir a cada ano' }).check()
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('ação')
    await page.getByRole('button', { name: 'Adicionar ação', exact: true }).click()
    await escolher(page, 'Tag da ação 1', `Cliente ${t}`)
    await page.getByRole('button', { name: 'Adicionar grupo', exact: true }).click()
    await escolher(page, 'Combinar grupos', 'Qualquer uma (OU)')
    await escolher(page, 'Combinar condições do grupo 1', 'Todas (E)')
    await escolher(page, 'Tag da condição 1.1', `Cliente ${t}`)
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Regras', exact: true })).toBeVisible()
    rule = (await api<{ id: string; name: string }[]>('/api/rules')).find(r => r.name === name)!.id
    await page.reload()
    await page.getByRole('button', { name, exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Repetir a cada ano' })).toBeChecked()
    await expect(page.getByRole('combobox', { name: 'Combinar grupos' })).toContainText('Qualquer uma (OU)')
    await expect(page.getByRole('combobox', { name: 'Tag da condição 1.1' })).toContainText(`Cliente ${t}`)
    if (process.env.E2E_CAPTURE_SCREENS === '1') {
      await page.getByRole('heading', { name: 'Editar regra', exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: caminhoPrint(`clone-screens/repintura/04-regras-condicao-data-${info.project.name}.png`), scale: 'css', animations: 'disabled' })
      await page.getByRole('combobox', { name: 'Tag da condição 1.1' }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: caminhoPrint(`clone-screens/repintura/04-regras-condicao-grupos-${info.project.name}.png`), scale: 'css', animations: 'disabled' })
    }
  } finally {
    if (rule) await api(`/api/rules/${rule}`, { method: 'DELETE' })
    sql([`DELETE FROM tags WHERE id='${tag}'`, `DELETE FROM custom_fields WHERE id='${date}'`])
  }
})
