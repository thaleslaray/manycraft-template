import { test, expect } from './fixtures'
import { WORKSPACE, api, consulta, q, sql } from './helpers'
import { subirInstagramFalso } from './instagram-falso'

// Ficha 15: Atualizar conexão do Instagram confere o token e as permissões, mostra o que está ok e o que falta, e deixa a conexão com erro até resolver.
test('Atualizar conexão do Instagram lista o que está ok e o que falta, e volta a conectar depois de resolver', async ({ page }) => {
  test.setTimeout(120_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development).toBeTruthy()
  const conta = '17840' + String(Math.floor(Math.random() * 900_000) + 100_000)
  const nome = 'Instagram de reparo com um nome bem comprido para testar quebra de linha 60'
  const falso = await subirInstagramFalso(Number(new URL(catalog.development!.providerApiBase).port), conta)
  let connection = ''
  try {
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'instagram', displayName: nome, credentials: { accessToken: 'e2e-only', accountId: conta, appSecret: 'e2e-app-secret' } }) })).connection.id
    sql([`UPDATE channels SET connection_state='connected', status='connected' WHERE id='${q(connection)}'`])
    await page.goto(`/${WORKSPACE}/settings/channels`)
    const card = page.getByRole('listitem').filter({ hasText: nome })
    const atualizar = card.getByRole('button', { name: 'Atualizar conexão' })
    const resultado = page.getByRole('dialog', { name: 'Conferência da conexão' })
    const linha = (rotulo: string) => resultado.getByRole('list', { name: 'Resultado da conferência' }).getByRole('listitem').filter({ hasText: new RegExp(`^${rotulo}`) })

    // Tudo certo: todos os itens ok e o webhook reassinado na conta.
    await atualizar.click()
    await expect(resultado).toBeVisible()
    for (const rotulo of ['Token de acesso', 'Mensagens', 'Comentários', 'Webhook']) await expect(linha(rotulo)).toContainText('Ok')
    // Com o login do Instagram a Meta não libera a curtida em comentário: o item aparece como indisponível, não como falta.
    await expect(linha('Curtidas em comentários')).toContainText('Indisponível')
    expect(falso.chamadas.some(c => c.path.endsWith(`/${conta}/subscribed_apps`))).toBe(true)
    // O webhook do app foi (re)assinado e a Meta falsa conferiu o callback no motor.
    expect(falso.verificacoes.length).toBeGreaterThan(0)
    expect(falso.verificacoes.every(v => v.ok)).toBe(true)
    // A Página ligada foi inscrita (com o token dela) e aparece como ok.
    await expect(linha('Página do Facebook')).toContainText('Ok')
    expect(falso.paginas.length).toBeGreaterThan(0)
    // Só o teclado: o foco fica dentro do diálogo e Esc fecha.
    await page.keyboard.press('Escape')
    await expect(resultado).toBeHidden()

    // Permissão de mensagens faltando: item "Falta" com o passo na Meta, e a conexão fica com erro e o motivo.
    falso.estado.mensagens = false
    await atualizar.click()
    await expect(linha('Mensagens')).toContainText('Falta')
    await expect(linha('Mensagens')).toContainText('instagram_manage_messages')
    await expect(linha('Comentários')).toContainText('Ok')
    await page.screenshot({ path: test.info().outputPath('reparar-instagram-falta.png'), scale: 'css' })
    await resultado.getByRole('button', { name: 'Fechar', exact: true }).first().click()
    await expect(card.getByText('Com erro', { exact: true })).toBeVisible()
    await expect(card.getByText(/Faltam permissões: mensagens/)).toBeVisible()
    expect(consulta<{ connection_state: string }>(`SELECT connection_state FROM channels WHERE id='${q(connection)}'`)[0].connection_state).toBe('error')

    // Corrigiu na Meta: atualizar de novo volta a conexão para conectada.
    falso.estado.mensagens = true
    await atualizar.click()
    await expect(linha('Mensagens')).toContainText('Ok')
    await page.keyboard.press('Escape')
    await expect(card.getByText('Conectada', { exact: true })).toBeVisible()

    // Token vencido: o motivo diz que o token venceu e as demais permissões ficam como não conferidas.
    falso.estado.tokenVencido = true
    await atualizar.click()
    await expect(linha('Token de acesso')).toContainText('Falta')
    await expect(linha('Token de acesso')).toContainText('venceu')
    await expect(linha('Mensagens')).toContainText('Não conferido')
    await page.keyboard.press('Escape')
    await expect(card.getByText(/O token venceu/)).toBeVisible()
    // Sem rolagem lateral, em celular e em desktop, mesmo com o nome comprido.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  } finally {
    if (connection) sql([`DELETE FROM channels WHERE id='${q(connection)}'`])
    await falso.fechar()
  }
})
