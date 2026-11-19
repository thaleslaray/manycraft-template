import { mkdirSync } from 'node:fs'
import { test, expect } from './fixtures'
import { WORKSPACE, consulta, novoTag, sql, pastaPrints } from './helpers'

test('cria contato e mantém telefone e e-mail no perfil após recarregar', { tag: "@celular" }, async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 })
  const tag = novoTag(), email = `manual-${tag}@example.test`, phone = `55119${Date.now().toString().slice(-8)}`
  try {
    await page.goto(`/${WORKSPACE}/contacts`)
    await expect(page.getByRole('row').filter({ has: page.getByRole('button') }).first()).toBeVisible()
    await capture('lista')
    await acaoDaLista(page, 'Criar novo contato')
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Primeiro nome', { exact: true }).fill('Lia')
    await dialog.getByLabel('Sobrenome', { exact: true }).fill(`Manual${tag}`)
    await dialog.getByLabel('Telefone', { exact: true }).fill(`+${phone}`)
    await dialog.getByLabel('E-mail', { exact: true }).fill(email)
    await capture('criar')
    await dialog.getByRole('button', { name: 'Salvar contato' }).click()
    await expect(page.getByRole('heading', { name: `Lia Manual${tag}` })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('dialog')).toContainText(phone)
    await expect(page.getByRole('dialog')).toContainText(email)
    await page.getByRole('dialog').getByText(email, { exact: false }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('dialog').getByText(email, { exact: false })).toBeVisible()
    await capture('perfil')
    expect(consulta(`SELECT phone,email FROM contacts WHERE email='${email}'`)).toEqual([{ phone, email }])
  } finally { sql([`DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND email='${email}'`]) }

  async function capture(name: string) {
    if (!process.env.CAPTURE_TICKET_26) return
    const dir = pastaPrints("clone-screens")
    mkdirSync(dir, { recursive: true })
    await page.screenshot({ animations: 'disabled', scale: 'css', path: `${dir}/26-${name}-${info.project.name}.png` })
  }
})

test('importa cinco linhas, atualiza duplicada, ignora inválida e apresenta relatório persistente', { tag: "@celular" }, async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 })
  const t = novoTag(), field = `e2e-import-field-${t}`, tag = `e2e-import-tag-${t}`
  const suffix = `Import${t}`
  sql([
    `INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('${field}','${WORKSPACE}','Cidade ${t}','text')`,
    `INSERT INTO tags(id,workspace_id,name) VALUES ('${tag}','${WORKSPACE}','Lista ${t}')`,
  ])
  try {
    await page.goto(`/${WORKSPACE}/contacts`)
    await acaoDaLista(page, 'Importar')
    const dialog = page.getByRole('dialog')
    const csv = `Nome;Sobrenome;Email;Cidade\nAna;${suffix};ana-${t}@example.test;Recife\nBruno;${suffix};bruno-${t}@example.test;Natal\nAna revisada;${suffix};ANA-${t}@example.test;Olinda\nInválida;${suffix};sem-arroba;Fortaleza\nClara;${suffix};clara-${t}@example.test;Salvador`
    await dialog.getByLabel('Arquivo CSV').setInputFiles({ name: 'contatos.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await expect(dialog.getByRole('button', { name: 'Mapear colunas' })).toBeDisabled()
    await capture('importar-arquivo')
    await dialog.getByRole('checkbox', { name: /Tenho consentimento/ }).check()
    await dialog.getByRole('button', { name: 'Mapear colunas' }).click()
    for (const [column, value] of [['Nome', 'first_name'], ['Sobrenome', 'last_name'], ['Email', 'email'], ['Cidade', `field:${field}`]]) {
      await dialog.getByLabel(`Campo para ${column}`, { exact: true }).selectOption(value)
    }
    await capture('importar-mapeamento')
    await dialog.getByRole('button', { name: 'Revisar importação' }).click()
    await dialog.getByRole('checkbox', { name: `Lista ${t}`, exact: true }).check()
    await capture('importar-revisao')
    await dialog.getByRole('button', { name: 'Iniciar importação' }).click()
    await expect(dialog.getByRole('heading', { name: 'Importação concluída' })).toBeVisible({ timeout: 30_000 })
    await expect(dialog).toContainText('3 criados')
    await expect(dialog).toContainText('1 atualizado')
    await expect(dialog).toContainText('1 ignorado')
    await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    await expect(dialog).toContainText('Linha 5')
    await capture('importar-relatorio')
    await page.reload()
    await expect(page.getByRole('dialog')).toContainText('3 criados')
    await page.getByRole('button', { name: 'Concluir', exact: true }).click()
    await page.getByRole('textbox', { name: 'Buscar contato' }).fill(suffix)
    await expect(page.getByRole('button', { name: `Ana revisada ${suffix}`, exact: true })).toBeVisible()
    expect(consulta(`SELECT first_name,email FROM contacts WHERE workspace_id='${WORKSPACE}' AND last_name='${suffix}' ORDER BY first_name`)).toEqual([
      { first_name: 'Ana revisada', email: `ana-${t}@example.test` },
      { first_name: 'Bruno', email: `bruno-${t}@example.test` },
      { first_name: 'Clara', email: `clara-${t}@example.test` },
    ])
    expect(consulta(`SELECT contact_count FROM tags WHERE id='${tag}'`)).toEqual([{ contact_count: 3 }])
    expect(consulta(`SELECT v.value FROM contact_field_values v JOIN contacts c ON c.id=v.contact_id WHERE v.field_id='${field}' AND c.first_name='Ana revisada'`)).toEqual([{ value: '"Olinda"' }])
  } finally {
    sql([
      `DELETE FROM contact_imports WHERE workspace_id='${WORKSPACE}' AND tag_ids='["${tag}"]'`,
      `DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND last_name='${suffix}'`,
      `DELETE FROM custom_fields WHERE id='${field}'`, `DELETE FROM tags WHERE id='${tag}'`,
    ])
  }
  async function capture(name: string) {
    if (!process.env.CAPTURE_TICKET_26) return
    const dir = pastaPrints("clone-screens")
    mkdirSync(dir, { recursive: true })
    await page.screenshot({ animations: 'disabled', scale: 'css', path: `${dir}/26-${name}-${info.project.name}.png` })
  }
})

/** No desktop a ação é um botão no topo; no celular ela vai para o menu ⋮ da lista. */
async function acaoDaLista(page: import('@playwright/test').Page, nome: string) {
  const botao = page.getByRole('button', { name: nome, exact: true })
  if ((page.viewportSize()?.width ?? 1440) >= 640) return botao.click()
  await page.getByRole('button', { name: 'Mais ações da lista' }).click()
  await page.getByRole('menuitem', { name: nome, exact: true }).click()
}
