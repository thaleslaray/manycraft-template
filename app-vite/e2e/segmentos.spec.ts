import { mkdirSync } from 'node:fs'
import { test, expect } from './fixtures'
import { WORKSPACE, consulta, escolher, novoTag, sql, pastaPrints } from './helpers'

test('filtra no motor, salva segmento, reabre e acompanha mudanças nos contatos', { tag: "@celular" }, async ({ page }, info) => {
  await page.setViewportSize(info.project.name === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 })
  const t = novoTag(), tag = `e2e-segment-tag-${t}`, a = `e2e-segment-a-${t}`, b = `e2e-segment-b-${t}`, name = `Interesse ${t}`, field = `e2e-segment-array-${t}`, fill = `e2e-segment-fill-${t}`
  sql([
    `INSERT INTO tags(id,workspace_id,name) VALUES ('${tag}','${WORKSPACE}','Interesse ${t}')`,
    // A lateral mostra 5 por grupo: com seis tags e seis segmentos, "Mostrar todos" existe sempre e o teste segue um caminho só.
    ...[1, 2, 3, 4, 5].map(i => `INSERT INTO tags(id,workspace_id,name) VALUES ('${fill}-t${i}','${WORKSPACE}','Preenchimento ${t} ${i}')`),
    ...[1, 2, 3, 4, 5, 6].map(i => `INSERT INTO segments(id,workspace_id,name,filter) VALUES ('${fill}-s${i}','${WORKSPACE}','Preenchimento ${t} ${i}','{"rules":[],"match":"all"}')`),
    ...[[a, 'Alice'], [b, 'Bruno']].map(([id, first]) => `INSERT INTO contacts(id,workspace_id,first_name,last_name) VALUES ('${id}','${WORKSPACE}','${first}','Segmento${t}')`),
    `INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES ('${WORKSPACE}','${a}','${tag}')`,
    `INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('${field}','${WORKSPACE}','Interesses ${t}','array')`,
    `INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES ('${WORKSPACE}','${a}','${field}','["curso"]')`,
  ])
  try {
    await page.goto(`/${WORKSPACE}/contacts`)
    await page.getByRole('button', { name: 'Filtrar contatos', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: '+ Condição', exact: true }).click()
    await escolher(page, 'Tipo de condição', 'Tag')
    await escolher(page, 'Tag da condição', `Interesse ${t}`)
    await page.getByRole('button', { name: 'Adicionar condição', exact: true }).click()
    await expect(page.getByRole('status', { name: 'Contagem do filtro' })).toHaveText('1 contato encontrado')
    await expect(page.getByRole('button', { name: `Alice Segmento${t}`, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: `Bruno Segmento${t}`, exact: true })).toHaveCount(0)
    await capture('filtro')
    await page.getByRole('button', { name: 'Salvar como segmento', exact: true }).and(page.locator(':enabled')).click()
    await page.getByLabel('Nome do segmento', { exact: true }).fill(name)
    await page.getByRole('button', { name: 'Salvar segmento', exact: true }).click()
    await expect(page).toHaveURL(/\/contacts\/segments\//)
    await page.reload()
    await expect(page.getByRole('navigation', { name: 'Você está em' })).toContainText('Segmentos')
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    const saved = consulta<{ id: string; filter: string }>(`SELECT id,filter FROM segments WHERE workspace_id='${WORKSPACE}' AND name='${name}'`)
    expect(saved).toHaveLength(1)
    expect(JSON.parse(saved[0].filter).rules[0].tag_id).toBe(tag)
    sql([`INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES ('${WORKSPACE}','${b}','${tag}')`])
    await page.reload()
    await expect(page.getByRole('status', { name: 'Contagem do filtro' })).toHaveText('2 contatos encontrados')
    await expect(page.getByRole('button', { name: `Bruno Segmento${t}`, exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Filtrar contatos' }).click()
    await capture('segmento')
    await escolher(page, 'Tipo de condição', 'Campo personalizado')
    await escolher(page, 'Campo da condição', `Interesses ${t}`)
    await page.getByLabel('Valor da condição').fill('texto que não é lista')
    await expect(page.getByRole('button', { name: 'Adicionar condição', exact: true })).toBeDisabled()
    await page.getByLabel('Valor da condição').fill('["curso"]')
    await page.getByRole('button', { name: 'Adicionar condição', exact: true }).click()
    await expect(page.getByRole('status', { name: 'Contagem do filtro' })).toHaveText('1 contato encontrado')
    await escolher(page, 'Combinar condições', 'Qualquer condição')
    await expect(page.getByRole('status', { name: 'Contagem do filtro' })).toHaveText('2 contatos encontrados')
    await page.getByRole('button', { name: 'Atualizar segmento', exact: true }).click()
    await expect(page.getByText('Segmento atualizado.', { exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Filtrar contatos' }).click()
    await expect(page.getByRole('combobox', { name: 'Combinar condições' })).toHaveText('Qualquer condição')
    await page.getByRole('button', { name: 'Remover condição 1' }).click()
    await expect(page.getByRole('status', { name: 'Contagem do filtro' })).toHaveText('1 contato encontrado')
    await page.getByRole('button', { name: 'Remover condição 1' }).click()
    await expect(page.getByRole('button', { name: 'Salvar como segmento' }).first()).toBeDisabled()
    await page.keyboard.press('Escape')
    // A lateral mostra 5 por grupo; a tag do teste pode estar atrás de "Mostrar todos", que existe sempre (há mais de cinco tags).
    const tags = page.getByRole('complementary', { name: 'Filtros rápidos' }).getByRole('region', { name: 'Tags' })
    await tags.getByRole('button', { name: 'Mostrar todos' }).click()
    await tags.getByRole('button', { name: new RegExp(name) }).click()
    await expect(page.getByRole('status', { name: 'Contagem do filtro' })).toHaveText('2 contatos encontrados')
    // O atalho para a lista inteira fica no fim da lateral de segmentos, depois de "Mostrar todos" (há mais de cinco segmentos).
    const segmentosSalvos = page.getByRole('navigation', { name: 'Segmentos salvos' })
    await segmentosSalvos.getByRole('button', { name: 'Mostrar todos' }).click()
    await segmentosSalvos.getByRole('link', { name: 'Todos os segmentos', exact: true }).click()
    await expect(page.getByRole('link', { name: `Abrir ${name}`, exact: true })).toBeVisible()
    await capture('segmentos')
  } finally {
    sql([`DELETE FROM segments WHERE workspace_id='${WORKSPACE}' AND (name='${name}' OR id LIKE '${fill}-%')`, `DELETE FROM contacts WHERE id IN ('${a}','${b}')`, `DELETE FROM tags WHERE id='${tag}' OR id LIKE '${fill}-%'`, `DELETE FROM custom_fields WHERE id='${field}'`])
  }
  async function capture(screen: string) {
    if (!process.env.CAPTURE_TICKET_27) return
    const dir = pastaPrints("clone-screens")
    mkdirSync(dir, { recursive: true })
    if (info.project.name === 'mobile' && screen !== 'segmentos') await page.getByRole('region', { name: 'Construtor de filtro' }).scrollIntoViewIfNeeded()
    await page.screenshot({ animations: 'disabled', scale: 'css', path: `${dir}/27-${screen}-${info.project.name}.png` })
  }
})
