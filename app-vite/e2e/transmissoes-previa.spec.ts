import { test, expect } from './fixtures'
import { WORKSPACE, acaoDoTopo, api, escolher, novoTag, sql } from './helpers'
import { subirTelegramFalso } from './telegram-falso'

test('prévia do público lista quem recebe, com nome e página', async ({ page }) => {
  test.setTimeout(90_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development, 'Provedor falso obrigatório nesta jornada').toBeTruthy()
  const t = novoTag(), botId = 9700000 + Math.floor(Math.random() * 200000), token = `${botId}:E2E-${t}`
  const fake = await subirTelegramFalso(Number(new URL(catalog.development!.providerApiBase).port), { [token]: { id: botId, username: `previa_${t}` } })
  try {
    const connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', displayName: `Bot da prévia ${t}`, credentials: { botToken: token } }) })).connection.id
    const total = 23
    sql(Array.from({ length: total }, (_, i) => i + 1).flatMap(i => [
      `INSERT INTO contacts(id,workspace_id,first_name,last_name) VALUES ('e2e-pv-${t}-${String(i).padStart(2, '0')}','${WORKSPACE}','Ouvinte ${String(i).padStart(2, '0')}','${t}')`,
      `INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('e2e-pv-${t}-${String(i).padStart(2, '0')}-cc','${WORKSPACE}','e2e-pv-${t}-${String(i).padStart(2, '0')}','${connection}','${5601000 + i}',1)`,
    ]))
    await page.goto(`/${WORKSPACE}/broadcasts`)
    await acaoDoTopo(page, 'Nova transmissão')
    await page.getByLabel('Nome da transmissão').fill(`Prévia do público ${t}`)
    await escolher(page, 'Canal conectado', `Bot da prévia ${t}`)
    await page.getByRole('button', { name: /^Público alvo/ }).click()
    await page.getByRole('button', { name: `Visualização prévia de ${total} contatos`, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Prévia do público' })
    const lista = dialog.getByRole('list', { name: 'Contatos que recebem' })
    await expect(lista.getByRole('listitem')).toHaveCount(20)
    await expect(lista.getByRole('listitem').first()).toContainText(`Ouvinte 01 ${t}`)
    await expect(dialog.getByText('Página 1 de 2')).toBeVisible()
    await dialog.getByRole('button', { name: 'Próxima', exact: true }).click()
    await expect(lista.getByRole('listitem')).toHaveCount(3)
    await expect(lista.getByRole('listitem').last()).toContainText(`Ouvinte 23 ${t}`)
    await expect(dialog.getByText('Página 2 de 2')).toBeVisible()
  } finally {
    try { sql([`DELETE FROM contacts WHERE id LIKE 'e2e-pv-${t}-%'`]) } finally { await fake.fechar() }
  }
})
