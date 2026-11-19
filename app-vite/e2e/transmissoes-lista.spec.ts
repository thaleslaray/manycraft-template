import { test, expect } from './fixtures'
import { WORKSPACE, canalE2eSql, novoTag, q, sql, caminhoPrint } from './helpers'

test('lista de transmissões: seções Agendado e Rascunhos em tabela, menu ⋮ por linha e lista completa', { tag: "@celular" }, async ({ page }, info) => {
  const desktop = info.project.name === 'desktop'
  await page.setViewportSize(desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 })
  const t = novoTag(), canal = `e2e-bl-${t}`, prefixo = `Lista ${t}`
  const agora = Date.now(), dia = 86_400_000
  const linhas = [
    ...[1, 2, 3, 4, 5].map(i => ({ id: `e2e-bl-${t}-a${i}`, nome: `${prefixo} agendada ${i}`, status: 'scheduled', em: agora + i * dia })),
    ...[1, 2, 3, 4, 5, 6].map(i => ({ id: `e2e-bl-${t}-r${i}`, nome: `${prefixo} rascunho ${i}`, status: 'draft', em: agora - i * 3_600_000 })),
  ]
  sql([
    ...canalE2eSql(canal),
    ...linhas.map(l => `INSERT INTO broadcasts(id,workspace_id,name,channel_id,audience_filter,status,scheduled_at,content,timezone,updated_at) VALUES ('${l.id}','${WORKSPACE}','${q(l.nome)}','${canal}','{"tag":"all"}','${l.status}',${l.status === 'scheduled' ? l.em : 'NULL'},'Olá','America/Sao_Paulo',${l.em})`),
  ])
  try {
    await page.goto(`/${WORKSPACE}/broadcasts`)
    const agendado = page.getByRole('region', { name: 'Agendado', exact: true })
    const rascunhos = page.getByRole('region', { name: 'Rascunhos', exact: true })
    if (desktop) {
      await expect(agendado.getByRole('columnheader', { name: 'Iniciar', exact: true })).toBeVisible()
      await expect(agendado.getByRole('columnheader', { name: 'Nome', exact: true })).toBeVisible()
      await expect(rascunhos.getByRole('columnheader', { name: 'Última edição', exact: true })).toBeVisible()
    }

    // Agendado mostra 3 linhas e Rascunhos até 5; "Ver todas" abre a lista completa, com busca pelo nome.
    const filtro = (nome: string) => new RegExp(`${prefixo} ${nome}`)
    await expect(page.getByRole('heading', { name: 'Mensagem em massa', exact: true })).toBeVisible()
    await expect(agendado.getByRole('row').filter({ hasText: filtro('agendada') })).toHaveCount(3)
    await expect(rascunhos.getByRole('row').filter({ hasText: filtro('rascunho') })).toHaveCount(5)
    await agendado.getByRole('button', { name: /^Veja todas as [\d.]+ mensagens$/ }).click()
    await expect(page).toHaveURL(/lista=agendado/)
    await page.getByRole('searchbox', { name: 'Buscar transmissão pelo nome' }).fill(prefixo)
    await expect(agendado.getByRole('row').filter({ hasText: filtro('agendada') })).toHaveCount(5)
    await page.getByRole('link', { name: 'Voltar à mensagem em massa' }).click()
    await expect(page).not.toHaveURL(/lista=/)

    // Data sem o nome técnico do fuso.
    const primeira = agendado.getByRole('row').filter({ hasText: `${prefixo} agendada 5` })
    await expect(primeira).not.toContainText(/America\/|Sao_Paulo|UTC|GMT/)

    await page.mouse.move(0, 0)
    await page.screenshot({ animations: 'disabled', scale: 'css', path: caminhoPrint(`clone-screens/repintura/07-transmissoes-lista-${desktop ? 'desktop' : 'mobile'}.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    // Ações da linha no menu ⋮.
    await primeira.getByRole('button', { name: `Mais ações de ${prefixo} agendada 5`, exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Continuar edição' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Pausar envio' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Cancelar agendamento' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Continuar edição' }).click()
    await expect(page).toHaveURL(/\/broadcasts\/e2e-bl-[^/]+$/)
    await expect(page.getByLabel('Nome da transmissão')).toHaveValue(`${prefixo} agendada 5`)
    // O editor estima o público ao abrir; espera a estimativa terminar antes do finally apagar o canal (senão o 404 cai no console).
    await expect(page.getByText(/contatos? receber(á|ão) esta transmissão/).first()).toBeVisible()
  } finally {
    sql([`DELETE FROM broadcasts WHERE workspace_id='${WORKSPACE}' AND id LIKE 'e2e-bl-${t}-%'`, `DELETE FROM channels WHERE id='${canal}'`])
  }
})
