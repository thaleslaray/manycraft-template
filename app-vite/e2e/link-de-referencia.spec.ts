import { test, expect } from './fixtures'
import { WORKSPACE, api, novoTag, q, sql } from './helpers'

test('cria, copia, baixa o QR, ativa e exclui um link de referência do Messenger', async ({ page, context }, info) => {
  test.skip(info.project.name === 'mobile', 'No celular o editor é só leitura ("Use uma tela maior para editar"); a jornada de edição é só desktop.')
  test.setTimeout(120_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
  const tag = novoTag(), canal = `ms-${tag}`, handle = `oficina.${tag}`
  sql([`INSERT INTO channels(id,workspace_id,type,external_id,status,display_name) VALUES ('${canal}','${WORKSPACE}','messenger','page-${tag}','connected','Página ${tag}')`])
  let id: string | undefined
  try {
    id = (await api<{ id: string }>('/api/automations', { method: 'POST', body: JSON.stringify({ name: `Link ${tag}` }) })).id
    await api(`/api/automations/${id}/draft`, { method: 'PUT', body: JSON.stringify({ graph: {
      nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'message', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Oi!' }] } }],
      edges: [{ from: 'trigger', port: 'next', to: 'message' }] } }) })
    // O Messenger não aparece no pop-up "Iniciar automação quando…" (fora do escopo do projeto); o gatilho nasce pelo motor e o painel do link é o que se testa.
    await api(`/api/automations/${id}/triggers`, { method: 'POST', body: JSON.stringify({ type: 'ref_url', name: 'Link da bio', connection_id: canal, node_id: 'trigger', config: { handle } }) })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await page.locator('.react-flow__node-trigger').click({ position: { x: 40, y: 16 } })
    const link = page.getByLabel('Link', { exact: true })
    await expect(link).toHaveValue(new RegExp(`^https://m\\.me/${handle.replace('.', '\\.')}\\?ref=[a-hj-km-np-z2-9]{8}$`))
    const codigo = (await link.inputValue()).split('ref=')[1]
    await expect(page.getByRole('img', { name: 'QR code do link' })).toBeVisible()
    const baixa = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Baixar QR em PNG' }).click()
    expect((await baixa).suggestedFilename()).toBe('qr-link-da-bio.png')
    await page.getByRole('button', { name: 'Copiar', exact: true }).click()
    await expect(page.getByText('Link copiado')).toBeVisible()
    await page.getByRole('combobox', { name: 'Estado do link' }).click()
    await page.getByRole('option', { name: 'Desligado', exact: true }).click()
    const salvo = page.waitForResponse(r => r.request().method() === 'PATCH' && /\/triggers\//.test(r.url()))
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    expect((await salvo).status()).toBe(200)
    await expect(page.getByText('Link salvo')).toBeVisible()
    await page.reload()
    await page.locator('.react-flow__node-trigger').click({ position: { x: 40, y: 16 } })
    await expect(page.getByLabel('Link', { exact: true })).toHaveValue(new RegExp(`ref=${codigo}$`))
    await page.getByRole('button', { name: 'Excluir link', exact: true }).first().click()
    await page.getByRole('dialog').getByRole('button', { name: 'Excluir link', exact: true }).click()
    await expect(page.getByText(/Link excluído/)).toBeVisible()
    const restante = await api<{ rows: { type: string }[] }>(`/api/automations/${id}/triggers`)
    expect(restante.rows.filter(r => r.type === 'ref_url')).toHaveLength(0)
  } finally {
    if (id) sql([`DELETE FROM triggers WHERE automation_id='${q(id)}'`, `DELETE FROM automations WHERE id='${q(id)}'`])
    sql([`DELETE FROM channels WHERE id='${canal}'`])
  }
})
