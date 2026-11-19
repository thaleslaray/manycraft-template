import type { Page, TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { test, expect } from './fixtures'
import { WORKSPACE, canalE2eSql, contatoSql, limpezaSql, novoTag, sql, consulta, caminhoPrint } from './helpers'

async function capture(page: Page, info: TestInfo, name: string) {
  if (process.env.CAPTURE_TICKET28 !== '1') return
  const dialog = page.getByRole('dialog').last()
  if (await dialog.count()) await dialog.evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ animations: 'disabled', scale: 'css', path: caminhoPrint(`clone-screens/28-${name}-${info.project.name}.png`) })
}

test('pausa e descadastra em lote somente após a palavra e persiste ao recarregar', { tag: "@celular" }, async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 })
  const t = novoTag(), canal = `e2e-lote-${t}`, ids = [`e2e-lote-a-${t}`, `e2e-lote-b-${t}`]
  sql([...canalE2eSql(canal), ...ids.flatMap((id, i) => contatoSql({ id, canal, nome: `Pessoa ${i + 1}`, sobrenome: `Porta${t}` }))])
  try {
    await page.goto(`/${WORKSPACE}/contacts`)
    for (const [action, word] of [['Pausar automações…', 'PAUSAR'], ['Descadastrar contatos…', 'DESCADASTRAR']] as const) {
      await page.getByRole('textbox', { name: 'Buscar contato' }).fill(`Porta${t}`)
      await expect(page.getByRole('button', { name: `Pessoa 2 Porta${t}`, exact: true })).toBeVisible()
      await page.getByRole('checkbox', { name: 'Selecionar todos', exact: true }).check()
      if (word === 'PAUSAR') await capture(page, info, 'lista')
      await page.getByRole('button', { name: 'Ações em lote', exact: true }).click()
      await page.getByRole('menuitem', { name: action, exact: true }).click()
      const dialog = page.getByRole('dialog')
      const confirm = dialog.getByRole('button', { name: 'Confirmar', exact: true })
      await expect(confirm).toBeDisabled()
      await dialog.getByRole('textbox', { name: `Digite ${word} para confirmar` }).fill(word.toLowerCase())
      await expect(confirm).toBeDisabled()
      await dialog.getByRole('textbox').fill(word)
      await capture(page, info, word === 'PAUSAR' ? 'pausar-lote' : 'descadastrar-lote')
      await confirm.click()
      await expect(dialog).toHaveCount(0)
      await page.reload()
    }
    const rows = consulta<{status:string;automation_paused_until:number}>(`SELECT status,automation_paused_until FROM contacts WHERE id IN ('${ids.join("','")}')`)
    expect(rows).toHaveLength(2)
    for (const row of rows) { expect(row.status).toBe('unsubscribed'); expect(row.automation_paused_until).toBeGreaterThan(Date.now()) }
    expect(consulta(`SELECT opted_in FROM contact_channels WHERE contact_id IN ('${ids.join("','")}')`)).toEqual([{ opted_in: 0 }, { opted_in: 0 }])
  } finally { sql(limpezaSql()) }
})

test('baixa JSON e compara dois contatos antes de mesclar', { tag: "@celular" }, async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 })
  const t = novoTag(), primary = `e2e-primary-${t}`, secondary = `e2e-secondary-${t}`
  const canal = `e2e-connection-${t}`, other = `e2e-other-${t}`, conversation = `e2e-conv-${t}`
  sql([...canalE2eSql(canal), ...canalE2eSql(other, 'instagram'),
    ...contatoSql({ id: primary, canal, nome: 'Ana', sobrenome: `Merge${t}` }),
    ...contatoSql({ id: secondary, canal: other, nome: 'Ana duplicada', sobrenome: `Merge${t}`, conversa: { id: conversation, mensagens: [{ id: `e2e-msg-${t}`, texto: 'Histórico preservado' }] } })])
  try {
    await page.goto(`/${WORKSPACE}/contacts?contact=${secondary}`)
    await expect(page.getByRole('button', { name: 'Mais ações do contato', exact: true })).toBeVisible()
    await capture(page, info, 'perfil')
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Mais ações do contato', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Baixar dados (JSON)', exact: true }).click()
    const file = await download
    const exported = JSON.parse(await readFile((await file.path())!, 'utf8'))
    expect(exported.contact.id).toBe(secondary)
    expect(exported).toHaveProperty('tags')
    expect(exported).toHaveProperty('fields')
    expect(JSON.stringify(exported.conversations)).toContain('Histórico preservado')
    expect(JSON.stringify(exported)).not.toMatch(/credentials_ciphertext|webhook_secret/)
    await page.goto(`/${WORKSPACE}/contacts?contact=${primary}`)
    await page.getByRole('button', { name: 'Mais ações do contato', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Mesclar contato…', exact: true }).click()
    const dialog = page.getByRole('dialog').last()
    await dialog.getByRole('textbox', { name: 'Buscar contato para mesclar' }).fill(`Ana duplicada Merge${t}`)
    await dialog.getByRole('button', { name: `Ana duplicada Merge${t}`, exact: true }).click()
    await expect(dialog.getByRole('region', { name: 'Comparação dos contatos' })).toContainText('Ana duplicada')
    const confirm = dialog.getByRole('button', { name: 'Confirmar mescla', exact: true })
    await expect(confirm).toBeDisabled()
    await dialog.getByRole('textbox', { name: 'Digite MESCLAR para confirmar' }).fill('MESCLAR')
    await capture(page, info, 'mesclar-comparacao')
    await confirm.click()
    await expect(page.getByRole('heading', { name: 'Mesclar contatos', exact: true })).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('region', { name: 'Inscrição por conexão' })).toContainText('Canal de teste e2e')
    expect(consulta(`SELECT contact_id FROM contact_channels WHERE id='${secondary}-cc'`)).toEqual([{ contact_id: primary }])
    expect(consulta(`SELECT status FROM contacts WHERE id='${secondary}'`)).toEqual([{ status: 'deleted' }])
    expect(consulta(`SELECT id FROM conversations WHERE id='${conversation}'`)).toHaveLength(1)
  } finally { sql(limpezaSql()) }
})

test('encontra duplicados nas próximas páginas e bloqueia mescla de identidades do mesmo canal', { tag: "@celular" }, async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 })
  const t = novoTag(), canal = `e2e-pages-${t}`, primary = `e2e-main-${t}`
  const ids = Array.from({ length: 42 }, (_, i) => `e2e-candidate-${t}-${String(i).padStart(2, '0')}`)
  sql([...canalE2eSql(canal), ...contatoSql({ id: primary, canal, nome: 'Principal', sobrenome: t }),
    ...ids.flatMap(id => contatoSql({ id, canal, nome: 'Duplicado', sobrenome: `Igual${t}` })),
    `UPDATE contacts SET subscribed_at=1 WHERE id='${ids[0]}'`])
  try {
    await page.goto(`/${WORKSPACE}/contacts?contact=${primary}`)
    await page.getByRole('button', { name: 'Mais ações do contato', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Mesclar contato…', exact: true }).click()
    const dialog = page.getByRole('dialog').last()
    await dialog.getByRole('textbox', { name: 'Buscar contato para mesclar' }).fill(`Duplicado Igual${t}`)
    await expect(dialog.getByRole('button', { name: `Duplicado Igual${t}`, exact: true })).toHaveCount(40)
    await dialog.getByRole('button', { name: 'Carregar mais contatos', exact: true }).click()
    await expect(dialog.getByRole('button', { name: `Duplicado Igual${t}`, exact: true })).toHaveCount(42)
    await dialog.getByRole('button', { name: `Duplicado Igual${t}`, exact: true }).last().click()
    await expect(dialog.getByRole('alert')).toContainText('mesmo canal')
    await expect(dialog.getByRole('button', { name: 'Confirmar mescla', exact: true })).toBeDisabled()
    await capture(page, info, 'mescla-bloqueada')
    expect(consulta(`SELECT status FROM contacts WHERE id='${ids[0]}'`)).toEqual([{ status: 'subscribed' }])
  } finally { sql(limpezaSql()) }
})
